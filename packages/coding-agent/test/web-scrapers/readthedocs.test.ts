import { afterEach, describe, expect, test, vi } from "bun:test";
import { handleReadTheDocs } from "../../src/web/scrapers/readthedocs";
import * as pages from "../../src/web/scrapers/types";
import type { LoadPageResult } from "../../src/web/scrapers/types";

const pageUrl = "https://niquests.readthedocs.io/en/v3.18.5/user/quickstart.html";
const editUrl = "https://github.com/jawah/niquests/edit/main/docs/user/quickstart.rst";
const releasedSource = "https://github.com/jawah/niquests/blob/v3.18.5/docs/user/quickstart.rst";
const rawUrl = "https://raw.githubusercontent.com/jawah/niquests/v3.18.5/docs/user/quickstart.rst";
const html = `<!doctype html><html><head>
<meta name="readthedocs-version-slug" content="v3.18.5">
</head><body><a href="${editUrl}">Edit this page</a>
<main><h1>Quickstart</h1><p>Released API: <code>niquests.get</code>.</p>
<nav>Navigation noise</nav></main></body></html>`;

function stubPages(content = html, source: Partial<LoadPageResult> = {}, finalUrl = pageUrl) {
	return vi.spyOn(pages, "loadPage").mockImplementation(async requestedUrl => {
		if (requestedUrl === pageUrl) {
			return { ok: true, content, contentType: "text/html", finalUrl, status: 200 };
		}
		return {
			ok: true,
			content: "Development API: main-only method.",
			contentType: "text/plain",
			finalUrl: requestedUrl,
			status: 200,
			...source,
		};
	});
}

afterEach(() => vi.restoreAllMocks());

describe("Read the Docs version provenance", () => {
	test("keeps v3.18.5 HTML when the page's Edit link targets main (#16835)", async () => {
		const loadPage = stubPages();
		const result = await handleReadTheDocs(pageUrl, 20);
		expect(result?.content).toContain("Released API: `niquests.get`");
		expect(result?.content).not.toContain("Development API");
		expect(result?.content).not.toContain("Navigation noise");
		expect(result?.contentType).toBe("text/html");
		expect(result?.finalUrl).toBe(pageUrl);
		expect(result?.notes.join("\n")).not.toContain("Fetched raw source");
		expect(loadPage.mock.calls.map(([url]) => url)).toEqual([pageUrl]);
	});

	test("uses a matching GitHub release source after skipping a development Edit link", async () => {
		stubPages(html.replace("<main>", `<a href="${releasedSource}?plain=1#L10">View source</a><main>`), {
			content: "Release source\n==============\nVersion-specific RST.",
			finalUrl: rawUrl,
		});
		const result = await handleReadTheDocs(pageUrl, 20);
		expect(result?.content).toContain("Version-specific RST.");
		expect(result?.content).not.toContain("Released API");
		expect(result?.contentType).toBe("text/plain");
		expect(result?.notes.join("\n")).toContain(rawUrl);
	});

	test("uses a matching GitLab source in a nested group", async () => {
		const gitlabRaw = "https://gitlab.com/group/subgroup/project/-/raw/v3.18.5/docs/quickstart.rst";
		stubPages(html.replace(editUrl, gitlabRaw.replace("/raw/", "/edit/")), {
			content: "GitLab release source",
			finalUrl: gitlabRaw,
		});
		const result = await handleReadTheDocs(pageUrl, 20);
		expect(result?.content).toBe("GitLab release source");
		expect(result?.notes.join("\n")).toContain(gitlabRaw);
	});

	test("uses the versioned URL when older pages have no version metadata", async () => {
		const loadPage = stubPages(html.replace(/<meta[^>]+>/, ""));
		const result = await handleReadTheDocs(pageUrl, 20);
		expect(result?.content).toContain("Released API");
		expect(loadPage.mock.calls.map(([url]) => url)).toEqual([pageUrl]);
	});

	test("retains matching source retrieval without version metadata", async () => {
		stubPages(html.replace(/<meta[^>]+>/, "").replace(editUrl, releasedSource), {
			content: "Versioned source without metadata",
		});
		const result = await handleReadTheDocs(pageUrl, 20);
		expect(result?.content).toBe("Versioned source without metadata");
		expect(result?.contentType).toBe("text/plain");
	});

	test("does not mistake a GitLab file path for a version-matched repository ref", async () => {
		const link = "https://gitlab.com/group/project/-/blob/main/docs/blob/v3.18.5/quickstart.rst";
		const loadPage = stubPages(html.replace(editUrl, link));
		const result = await handleReadTheDocs(pageUrl, 20);
		expect(result?.content).toContain("Released API");
		expect(loadPage.mock.calls.map(([url]) => url)).toEqual([pageUrl]);
	});

	test("rejects source selection when URL and version metadata disagree", async () => {
		const loadPage = stubPages(html.replace('content="v3.18.5"', 'content="main"'));
		const result = await handleReadTheDocs(pageUrl, 20);
		expect(result?.content).toContain("Released API");
		expect(loadPage.mock.calls.map(([url]) => url)).toEqual([pageUrl]);
	});

	test.each(["latest", "stable"])("does not guess the Git ref for the %s alias", async alias => {
		const loadPage = stubPages(
			html.replaceAll("v3.18.5", alias).replace("/edit/main/", `/edit/${alias}/`),
			{},
			pageUrl.replace("v3.18.5", alias),
		);
		const result = await handleReadTheDocs(pageUrl, 20);
		expect(result?.content).toContain("Released API");
		expect(loadPage.mock.calls.map(([url]) => url)).toEqual([pageUrl]);
	});

	test("does not guess a version on unversioned pages without metadata", async () => {
		const loadPage = stubPages(
			html.replace(/<meta[^>]+>/, ""),
			{},
			"https://niquests.readthedocs.io/quickstart.html",
		);
		const result = await handleReadTheDocs(pageUrl, 20);
		expect(result?.content).toContain("Released API");
		expect(loadPage.mock.calls.map(([url]) => url)).toEqual([pageUrl]);
	});

	test("rejects a raw source redirect to a different ref", async () => {
		stubPages(html.replace(editUrl, releasedSource), { finalUrl: rawUrl.replace("v3.18.5", "main") });
		const result = await handleReadTheDocs(pageUrl, 20);
		expect(result?.content).toContain("Released API");
		expect(result?.contentType).toBe("text/html");
		expect(result?.notes.join("\n")).not.toContain("Fetched raw source");
	});

	test.each([
		{ ok: false, status: 404 },
		{ content: "" },
		{ content: "x".repeat(1_000_000) },
		{ truncated: true },
		{ contentType: "text/html", content: "<html>Sign in</html>" },
	])("returns HTML with correct provenance when raw source is unusable (%#)", async source => {
		stubPages(html.replace(editUrl, releasedSource), source);
		const result = await handleReadTheDocs(pageUrl, 20);
		expect(result?.content).toContain("Released API");
		expect(result?.contentType).toBe("text/html");
		expect(result?.notes.join("\n")).not.toContain("Fetched raw source");
	});

	test("returns HTML when a matching source request throws", async () => {
		vi.spyOn(pages, "loadPage").mockImplementation(async requestedUrl => {
			if (requestedUrl !== pageUrl) throw new Error("Connection reset");
			return {
				ok: true,
				content: html.replace(editUrl, releasedSource),
				contentType: "text/html",
				finalUrl: pageUrl,
			};
		});
		const result = await handleReadTheDocs(pageUrl, 20);
		expect(result?.content).toContain("Released API");
		expect(result?.contentType).toBe("text/html");
		expect(result?.notes.join("\n")).not.toContain("Fetched raw source");
	});

	test("ignores lookalike GitHub hosts", async () => {
		const loadPage = stubPages(html.replace(editUrl, releasedSource.replace("github.com", "github.com.example.org")));
		const result = await handleReadTheDocs(pageUrl, 20);
		expect(result?.content).toContain("Released API");
		expect(loadPage.mock.calls.map(([url]) => url)).toEqual([pageUrl]);
	});

	test("returns the page fetch failure without attempting raw source", async () => {
		const loadPage = vi.spyOn(pages, "loadPage").mockResolvedValue({
			ok: false,
			content: "Not found",
			contentType: "text/html",
			finalUrl: pageUrl,
			status: 404,
		});
		const result = await handleReadTheDocs(pageUrl, 20);
		expect(result?.content).toContain("404");
		expect(loadPage.mock.calls.map(([url]) => url)).toEqual([pageUrl]);
	});

	test("leaves unrelated hosts to other handlers", async () => {
		const loadPage = stubPages();
		expect(await handleReadTheDocs("https://example.com/en/v3.18.5/", 20)).toBeNull();
		expect(loadPage).not.toHaveBeenCalled();
	});
});
