/**
 * The search engines (search port + model slots wave, 2026-09-20):
 * engine resolution (the owner's auto-detect decision — a key is enough,
 * no engine choice needed; explicit pin requires the key; no silent
 * fallback) + the Tavily/Brave adapters against a STUB fetch (never the
 * network — the wire shapes are verified against the published docs, and
 * the tests pin those shapes).
 *
 * PURE + injected fetch — this file owns no fs.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveSearchEngineFor, tavilyProvider, braveProvider, firecrawlProvider, resetFirecrawlSearchCache } from "../src/server/search.ts";
import { FirecrawlSearchUnsupportedError } from "../src/core/firecrawl.ts";

describe("resolveSearchEngineFor (the auto-detect decision)", () => {
	it("no keys: honestly unavailable, no default", () => {
		const out = resolveSearchEngineFor(undefined, {});
		assert.ok(!out.available);
		assert.equal(out.engine, null);
		assert.match(out.reason, /no search engine configured/i);
	});

	it("a key alone is enough — no engine choice needed", () => {
		const tav = resolveSearchEngineFor(undefined, { tavily: "tvly-throwaway-key-00001" });
		assert.ok(tav.available);
		assert.equal(tav.engine, "tavily");
		assert.match(tav.reason, /auto/);

		const brv = resolveSearchEngineFor(undefined, { brave: "brave-throwaway-key-00001" });
		assert.ok(brv.available);
		assert.equal(brv.engine, "brave");
	});

	it("both keys, no pin: preference order — Tavily first (owner decision)", () => {
		const out = resolveSearchEngineFor(undefined, {
			tavily: "tvly-throwaway-key-00001",
			brave: "brave-throwaway-key-00001",
		});
		assert.ok(out.available);
		assert.equal(out.engine, "tavily");
	});

	it("the explicit pin wins when its key is present", () => {
		const out = resolveSearchEngineFor("brave", {
			tavily: "tvly-throwaway-key-00001",
			brave: "brave-throwaway-key-00001",
		});
		assert.ok(out.available);
		assert.equal(out.engine, "brave");
		assert.match(out.reason, /chosen/);
	});

	it("the explicit pin does NOT silently fall back to the other engine", () => {
		const out = resolveSearchEngineFor("tavily", { brave: "brave-throwaway-key-00001" });
		assert.ok(!out.available);
		assert.equal(out.engine, null);
		assert.match(out.reason, /tavily/);
		assert.match(out.reason, /API key is missing/);
	});
});

/** A one-shot stub fetch: asserts the request shape and returns the canned response. */
function stubFetch(canned: unknown, expect: (url: string, init: RequestInit) => void) {
	return async (url: string, init: RequestInit): Promise<Response> => {
		expect(url, init);
		return new Response(JSON.stringify(canned), { status: 200 });
	};
}

describe("tavilyProvider (wire shape per docs.tavily.com, verified 2026-09-20)", () => {
	it("POSTs api.tavily.com/search with Bearer auth + the query body", async () => {
		const provider = tavilyProvider("tvly-throwaway-key-00001", stubFetch(
			{
				results: [
					{ title: "Example", url: "https://example.com/a", content: "line1\nline2" },
					{ title: "No URL", content: "dropped" },
				],
			},
			(url, init) => {
				assert.equal(url, "https://api.tavily.com/search");
				assert.equal(init.method, "POST");
				const headers = init.headers as Record<string, string>;
				assert.equal(headers.authorization, "Bearer tvly-throwaway-key-00001");
				const body = JSON.parse(init.body as string);
				assert.equal(body.query, "test query");
				assert.equal(body.max_results, 5);
				// The legacy api_key-in-body form is retired — auth is the header.
				assert.equal(body.api_key, undefined);
			},
		));
		const hits = await provider.search("test query", 5);
		assert.deepEqual(hits, [{ title: "Example", url: "https://example.com/a", snippet: "line1 line2" }]);
	});

	it("maps the {detail:{error}} error body into the message", async () => {
		const provider = tavilyProvider("tvly-throwaway-key-00001", async () =>
			new Response(JSON.stringify({ detail: { error: "Unauthorized: missing or invalid API key." } }), { status: 401 }),
		);
		await assert.rejects(provider.search("q", 5), /Tavily search API 401: Unauthorized/);
	});
});

describe("braveProvider (wire shape per Brave's dashboard docs, verified 2026-09-20)", () => {
	it("GETs res/v1/web/search with the X-Subscription-Token header", async () => {
		const provider = braveProvider("brave-throwaway-key-00001", stubFetch(
			{
				web: {
					results: [
						{ title: "Example", url: "https://example.com/b", description: "a description" },
						{ description: "dropped — no url" },
					],
				},
			},
			(url, init) => {
				assert.ok(url.startsWith("https://api.search.brave.com/res/v1/web/search?"), url);
				assert.ok(url.includes("q=test+query"), url); // URLSearchParams: spaces as +
				assert.ok(url.includes("count=5"));
				const headers = init.headers as Record<string, string>;
				assert.equal(headers["x-subscription-token"], "brave-throwaway-key-00001");
			},
		));
		const hits = await provider.search("test query", 5);
		assert.deepEqual(hits, [{ title: "Example", url: "https://example.com/b", snippet: "a description" }]);
	});

	it("surfaces the HTTP status on failure", async () => {
		const provider = braveProvider("brave-throwaway-key-00001", async () =>
			new Response("rate limited", { status: 429 }),
		);
		await assert.rejects(provider.search("q", 5), /Brave search API 429/);
	});
});

describe("resolveSearchEngineFor — Firecrawl", () => {
	const url = { apiUrl: "http://192.168.7.5:3002", apiKey: "fc-local-key" };

	it("a URL alone activates Firecrawl; it does not outrank a keyed engine", () => {
		const only = resolveSearchEngineFor(undefined, {}, url);
		assert.equal(only.engine, "firecrawl");
		assert.equal(only.apiUrl, "http://192.168.7.5:3002");
		assert.match(only.reason, /auto/);

		const tavily = resolveSearchEngineFor(undefined, { tavily: "tvly-throwaway-key-00001" }, url);
		assert.equal(tavily.engine, "tavily");
		assert.equal(tavily.apiUrl, null);

		const brave = resolveSearchEngineFor(undefined, { brave: "brave-throwaway-key-00001" }, url);
		assert.equal(brave.engine, "brave");
	});

	it("an explicit Firecrawl pin wins, and does not fall back when the URL is missing", () => {
		const chosen = resolveSearchEngineFor("firecrawl", { tavily: "tvly-throwaway-key-00001" }, url);
		assert.equal(chosen.engine, "firecrawl");
		assert.match(chosen.reason, /chosen/);
		const missing = resolveSearchEngineFor("firecrawl", { brave: "brave-throwaway-key-00001" }, null);
		assert.equal(missing.available, false);
		assert.match(missing.reason, /FIRECRAWL_API_URL is missing/);
	});

	it("a keyless world with no URL is unchanged", () => {
		const out = resolveSearchEngineFor(undefined, {});
		assert.equal(out.available, false);
		assert.match(out.reason, /no search engine configured/);
		assert.equal(out.apiUrl, null);
	});
});

describe("firecrawlProvider (v1 scrape + search)", () => {
	const api = "http://192.168.7.5:3002";

	it("scrapes with formats:[markdown] and no auth header when no key is set", async () => {
		const provider = firecrawlProvider(api, undefined, stubFetch(
			{ success: true, data: { markdown: "# Hello\n\nbody", metadata: { title: "Hello", sourceURL: "https://example.com/a", statusCode: 200 } } },
			(url, init) => {
				assert.equal(url, `${api}/v1/scrape`);
				assert.equal(init.method, "POST");
				assert.equal(init.redirect, "error");
				const headers = init.headers as Record<string, string>;
				assert.equal(headers.authorization, undefined);
				assert.deepEqual(JSON.parse(init.body as string), { url: "https://example.com/a", formats: ["markdown"] });
			},
		));
		const page = await provider.scrape("https://example.com/a");
		assert.equal(page.markdown, "# Hello\n\nbody");
		assert.equal(page.title, "Hello");
		assert.equal(page.sourceUrl, "https://example.com/a");
		assert.equal(page.statusCode, 200);
	});

	it("sends the optional key as a bearer token and keeps it out of errors", async () => {
		const key = "fc-throwaway-key";
		const provider = firecrawlProvider(api, key, async (_url, init) => {
			const headers = init?.headers as Record<string, string>;
			assert.equal(headers.authorization, `Bearer ${key}`);
			return new Response(JSON.stringify({ success: false, error: "blocked" }), { status: 403 });
		});
		await assert.rejects(provider.scrape("https://example.com/a"), (err: Error) => {
			assert.match(err.message, /Firecrawl scrape failed \(403\): blocked/);
			assert.equal(err.message.includes(key), false);
			return true;
		});
	});

	it("search posts /v1/search and maps hits", async () => {
		resetFirecrawlSearchCache();
		const provider = firecrawlProvider(api, undefined, stubFetch(
			{ success: true, data: [{ title: "Example", url: "https://example.com/b", description: "a description" }] },
			(url, init) => {
				assert.equal(url, `${api}/v1/search`);
				assert.deepEqual(JSON.parse(init.body as string), { query: "test query", limit: 5 });
			},
		));
		assert.deepEqual(await provider.search("test query", 5), [{ title: "Example", url: "https://example.com/b", snippet: "a description" }]);
	});

	it("a missing SearxNG endpoint is unsupported, and the next call does not hit the network", async () => {
		resetFirecrawlSearchCache();
		let calls = 0;
		const provider = firecrawlProvider(api, undefined, async () => {
			calls += 1;
			return new Response(JSON.stringify({ success: false, error: "Search is not configured. Set SEARXNG_ENDPOINT." }), { status: 400 });
		});
		await assert.rejects(provider.search("q", 1), (err: unknown) => err instanceof FirecrawlSearchUnsupportedError);
		await assert.rejects(provider.search("q", 1), (err: unknown) => err instanceof FirecrawlSearchUnsupportedError);
		assert.equal(calls, 1);
		resetFirecrawlSearchCache();
	});
});
