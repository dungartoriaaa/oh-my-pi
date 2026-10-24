/**
 * Read the Docs handler for web-fetch
 */
import { type Element, parseHTML } from "@oh-my-pi/pi-utils/dom";
import { buildResult, htmlToBasicMarkdown, loadPage, type RenderResult, type SpecialHandler } from "./types";

/** Canonical raw URL, only when the repository ref identifies the documented version. */
function versionedSourceUrl(href: string, version: string | undefined): string | null {
	// RTD aliases do not identify a repository ref, even if a branch has the same name.
	if (!version || version === "latest" || version === "stable") return null;
	try {
		const source = new URL(href);
		if (source.protocol !== "https:" || source.username || source.password || source.port) return null;
		let match: RegExpMatchArray | null;
		if (source.hostname === "github.com") {
			match = source.pathname.match(/^\/([^/]+\/[^/]+)\/(?:blob|edit|raw)\/([^/]+)\/(.+)$/);
			if (!match || decodeURIComponent(match[2]) !== version) return null;
			source.hostname = "raw.githubusercontent.com";
			source.pathname = `/${match[1]}/${match[2]}/${match[3]}`;
		} else if (source.hostname === "raw.githubusercontent.com") {
			match = source.pathname.match(/^\/[^/]+\/[^/]+\/([^/]+)\/.+$/);
			if (!match || decodeURIComponent(match[1]) !== version) return null;
		} else if (source.hostname === "gitlab.com") {
			match = source.pathname.match(/^\/(.+?\/-\/|[^/]+\/[^/]+\/)(?:blob|edit|raw)\/([^/]+)\/(.+)$/);
			if (!match || decodeURIComponent(match[2]) !== version) return null;
			source.pathname = `/${match[1]}raw/${match[2]}/${match[3]}`;
		} else {
			return null;
		}
		source.search = "";
		source.hash = "";
		return source.href;
	} catch {
		return null;
	}
}

export const handleReadTheDocs: SpecialHandler = async (
	url: string,
	timeout: number,
	signal?: AbortSignal,
): Promise<RenderResult | null> => {
	// Check if URL matches Read the Docs patterns
	const urlObj = new URL(url);
	const isReadTheDocs =
		urlObj.hostname.endsWith(".readthedocs.io") ||
		urlObj.hostname === "readthedocs.org" ||
		urlObj.hostname === "www.readthedocs.org";

	if (!isReadTheDocs) {
		return null;
	}

	const notes: string[] = [];
	const fetchedAt = new Date().toISOString();

	// Fetch the page
	const result = await loadPage(url, { timeout, signal });
	if (!result.ok) {
		return {
			url,
			finalUrl: result.finalUrl,
			contentType: result.contentType,
			method: "readthedocs",
			content: `Failed to fetch Read the Docs page (status: ${result.status ?? "unknown"})`,
			fetchedAt,
			truncated: false,
			notes,
		};
	}

	// Parse HTML
	const root = parseHTML(result.content).document;

	// Extract main content from common Read the Docs selectors
	let mainContent =
		root.querySelector(".document") ||
		root.querySelector('[role="main"]') ||
		root.querySelector("main") ||
		root.querySelector(".rst-content") ||
		root.querySelector(".body");

	if (!mainContent) {
		// Fallback to body if no main content found
		mainContent = root.querySelector("body");
		notes.push("Using full body content (no main content div found)");
	}

	// Remove navigation, sidebar, footer elements
	mainContent
		?.querySelectorAll(
			".headerlink, .viewcode-link, nav, .sidebar, footer, .related, .sphinxsidebar, .toctree-wrapper",
		)
		.forEach((el: Element) => {
			el.remove();
		});

	// An Edit link can target main even on a release page. Require agreement with
	// the built page's version, using the resolved URL for older pages without metadata.
	const pathVersion = new URL(result.finalUrl).pathname.match(
		/^\/(?:projects\/[^/]+\/)?[a-z]{2,3}(?:[-_][a-zA-Z0-9]+)*\/([^/]+)(?:\/|$)/,
	)?.[1];
	const metaVersion = root.querySelector('meta[name="readthedocs-version-slug"]')?.getAttribute("content")?.trim();
	const version = metaVersion && pathVersion && metaVersion !== pathVersion ? undefined : metaVersion || pathVersion;

	// Try to find a version-matched Edit on GitHub/GitLab link for raw source.
	const editLinks = root.querySelectorAll('a[href*="github.com"], a[href*="gitlab.com"]');
	let sourceUrl: string | null = null;

	for (const link of editLinks) {
		const href = link.getAttribute("href");
		const text = link.textContent?.toLowerCase() || "";

		if (href && (text.includes("edit") || text.includes("source"))) {
			sourceUrl = versionedSourceUrl(href, version);
			if (sourceUrl) break;
		}
	}

	let content = "";
	let contentType = "text/html";

	// Try to fetch raw source if available
	if (sourceUrl) {
		try {
			const sourceResult = await loadPage(sourceUrl, { timeout: Math.min(timeout, 10), signal });
			if (
				sourceResult.ok &&
				!sourceResult.truncated &&
				sourceResult.contentType !== "text/html" &&
				sourceResult.contentType !== "application/xhtml+xml" &&
				sourceResult.content.length > 0 &&
				sourceResult.content.length < 1_000_000 &&
				versionedSourceUrl(sourceResult.finalUrl, version) === sourceUrl
			) {
				content = sourceResult.content;
				contentType = "text/plain";
				notes.push(`Fetched raw source from ${sourceResult.finalUrl}`);
			}
		} catch {
			// Ignore errors, fall back to HTML
		}
	}

	// If no raw source, convert HTML to markdown
	if (!content && mainContent) {
		const html = mainContent.innerHTML;
		content = await htmlToBasicMarkdown(html);
	}

	if (!content) {
		content = "No content extracted from Read the Docs page";
		notes.push("Failed to extract content");
	}

	return buildResult(content, {
		url,
		finalUrl: result.finalUrl,
		method: "readthedocs",
		fetchedAt,
		notes,
		contentType,
	});
};
