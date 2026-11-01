/**
 * Firecrawl v1 shapes. No network, no key store — the adapter tests live
 * beside Brave in tests/search.test.ts.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	FirecrawlSearchUnsupportedError,
	normalizeFirecrawlApiUrl,
	parseFirecrawlScrape,
	parseFirecrawlSearch,
} from "../src/core/firecrawl.ts";

describe("normalizeFirecrawlApiUrl", () => {
	it("keeps the server root and strips a pasted /v1 path", () => {
		assert.equal(normalizeFirecrawlApiUrl("http://192.168.7.5:3002"), "http://192.168.7.5:3002");
		assert.equal(normalizeFirecrawlApiUrl("http://192.168.7.5:3002/"), "http://192.168.7.5:3002");
		assert.equal(normalizeFirecrawlApiUrl("http://192.168.7.5:3002/v1"), "http://192.168.7.5:3002");
		assert.equal(normalizeFirecrawlApiUrl("http://192.168.7.5:3002/v1/scrape"), "http://192.168.7.5:3002");
		assert.equal(normalizeFirecrawlApiUrl("https://api.firecrawl.dev"), "https://api.firecrawl.dev");
	});

	it("rejects non-http, credentials, and queries", () => {
		assert.equal(normalizeFirecrawlApiUrl(""), "");
		assert.equal(normalizeFirecrawlApiUrl("ftp://192.168.7.5:3002"), "");
		assert.equal(normalizeFirecrawlApiUrl("http://user:pass@192.168.7.5:3002"), "");
		assert.equal(normalizeFirecrawlApiUrl("http://192.168.7.5:3002?token=secret"), "");
		assert.equal(normalizeFirecrawlApiUrl("not a url"), "");
	});
});

describe("parseFirecrawlScrape", () => {
	it("reads success.data.markdown", () => {
		const page = parseFirecrawlScrape(200, JSON.stringify({
			success: true,
			data: { markdown: "# Title\n\nhello", metadata: { title: "Title", sourceURL: "https://example.com", statusCode: 200, contentType: "text/html" } },
		}), "https://example.com");
		assert.equal(page.markdown, "# Title\n\nhello");
		assert.equal(page.title, "Title");
		assert.equal(page.sourceUrl, "https://example.com");
		assert.equal(page.contentType, "text/html");
	});

	it("surfaces success:false and an empty page", () => {
		assert.throws(() => parseFirecrawlScrape(200, JSON.stringify({ success: false, error: "DNS resolution failed" }), "https://missing.example"), /DNS resolution failed/);
		assert.throws(() => parseFirecrawlScrape(200, JSON.stringify({ success: true, data: { markdown: "  " } }), "https://example.com"), /no readable markdown/);
	});
});

describe("parseFirecrawlSearch", () => {
	it("maps a data array and a data.web array", () => {
		const rows = parseFirecrawlSearch(200, JSON.stringify({
			success: true,
			data: [{ url: "https://example.com/a", title: "A", description: "one" }],
		}));
		assert.deepEqual(rows, [{ url: "https://example.com/a", title: "A", snippet: "one" }]);
		const web = parseFirecrawlSearch(200, JSON.stringify({ success: true, data: { web: [{ url: "https://example.com/b", title: "B", description: "two" }] } }));
		assert.equal(web[0]?.url, "https://example.com/b");
	});

	it("a SearxNG-less server is unsupported, not a generic failure", () => {
		assert.throws(
			() => parseFirecrawlSearch(400, JSON.stringify({ success: false, error: "Search is not configured. Please set SEARXNG_ENDPOINT." })),
			(err: unknown) => err instanceof FirecrawlSearchUnsupportedError,
		);
		assert.throws(() => parseFirecrawlSearch(404, "not found"), (err: unknown) => err instanceof FirecrawlSearchUnsupportedError);
		assert.throws(() => parseFirecrawlSearch(500, JSON.stringify({ success: false, error: "boom" })), /Firecrawl search failed \(500\): boom/);
	});
});
