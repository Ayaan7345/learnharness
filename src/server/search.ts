/**
 * The search engines' server composition (search port + model slots wave,
 * 2026-09-20): the Tavily + Brave adapters behind the core port
 * (core/search.ts) + the live-engine resolution the settings UI and the
 * agent-layer tool both read.
 *
 * Owner decisions (2026-09-20) baked in:
 *  - NO default engine: an engine is live iff its key is present (auth
 *    store or env — env wins, keyed via server/keys.ts keyValue).
 *  - Setting a key is ALL the user does — auto-detection: explicit
 *    agent.search.engine pins the preference (when BOTH keys are present
 *    the preference order is Tavily → Brave); without a pin, whichever
 *    engine has a key is the engine.
 *  - An explicit choice does NOT silently fall back to the other engine:
 *    engine pinned but its key missing = honestly unavailable (reason
 *    says so) — no guessing what the user meant.
 *
 * The adapters are injected dependencies (fetch-shaped) so the agent-layer
 * tool depends on the PORT only and tests never touch the network.
 */

import type { SearchEngineId, SearchHit, SearchProvider, SearchStatus } from "../core/search.ts";
import {
	FirecrawlSearchUnsupportedError,
	normalizeFirecrawlApiUrl,
	parseFirecrawlScrape,
	parseFirecrawlSearch,
	type PageReader,
	type ScrapedPage,
} from "../core/firecrawl.ts";
import { keyValue } from "./keys.ts";
import { effectiveSettings } from "./stores.ts";

/** The wire-callable shape the adapters close over (tests inject a stub). */
type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** Tavily: POST https://api.tavily.com/search — Bearer auth in the
 *  Authorization header (the current documented scheme; the legacy
 *  api_key-in-body form is retired), query + max_results (0–20) in the
 *  JSON body. VERIFIED against docs.tavily.com's OpenAPI, 2026-09-20:
 *  response {results: [{title, url, content, score, …}]}, errors
 *  {detail: {error}}. */
export function tavilyProvider(apiKey: string, fetchFn: FetchLike = fetch): SearchProvider {
	return {
		id: "tavily",
		async search(query: string, count: number): Promise<SearchHit[]> {
			const resp = await fetchFn("https://api.tavily.com/search", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${apiKey}`,
				},
				body: JSON.stringify({ query, max_results: Math.min(count, 20) }),
				signal: AbortSignal.timeout(30_000),
			});
			if (!resp.ok) {
				const body = await resp.text();
				// Their error body is {detail: {error: "…"}} — surface the
				// message when present, else the raw slice.
				let detail = body.slice(0, 200);
				try {
					const parsed = JSON.parse(body) as { detail?: { error?: string } };
					if (parsed.detail?.error) detail = parsed.detail.error.slice(0, 200);
				} catch {
					/* keep the raw slice */
				}
				throw new Error(`Tavily search API ${resp.status}: ${detail}`);
			}
			const data = (await resp.json()) as {
				results?: Array<{ title?: string; url?: string; content?: string }>;
			};
			return (data.results ?? [])
				.filter((r) => typeof r.url === "string" && r.url)
				.map((r) => ({
					title: r.title ?? r.url ?? "",
					url: r.url ?? "",
					snippet: (r.content ?? "").replace(/\n/g, " ").slice(0, 500),
				}));
		},
	};
}

/** Brave: GET https://api.search.brave.com/res/v1/web/search with the
 *  key in the X-Subscription-Token header. VERIFIED against Brave's
 *  dashboard docs, 2026-09-20: count max 20; response
 *  {web: {results: [{title, url, description, …}]}}. */
export function braveProvider(apiKey: string, fetchFn: FetchLike = fetch): SearchProvider {
	return {
		id: "brave",
		async search(query: string, count: number): Promise<SearchHit[]> {
			const url = new URL("https://api.search.brave.com/res/v1/web/search");
			url.searchParams.set("q", query);
			url.searchParams.set("count", String(Math.min(count, 20)));
			const resp = await fetchFn(url.toString(), {
				headers: {
					accept: "application/json",
					"x-subscription-token": apiKey,
				},
				signal: AbortSignal.timeout(30_000),
			});
			if (!resp.ok) {
				const body = await resp.text();
				throw new Error(`Brave search API ${resp.status}: ${body.slice(0, 200)}`);
			}
			const data = (await resp.json()) as {
				web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
			};
			return (data.web?.results ?? [])
				.filter((r) => typeof r.url === "string" && r.url)
				.map((r) => ({
					title: r.title ?? r.url ?? "",
					url: r.url ?? "",
					snippet: (r.description ?? "").replace(/\n/g, " ").slice(0, 500),
				}));
		},
	};
}

/** Keyed engines in PREFERENCE order (no explicit pin → the first live
 *  engine wins; owner decision 2026-09-20: Tavily first). Firecrawl is
 *  last and is not in this list: it is live when FIRECRAWL_API_URL is
 *  set, not when a key is set, and it must not take search away from a
 *  keyed Tavily or Brave. */
const ENGINE_ORDER: ReadonlyArray<{ id: "tavily" | "brave"; envVar: string }> = [
	{ id: "tavily", envVar: "TAVILY_API_KEY" },
	{ id: "brave", envVar: "BRAVE_API_KEY" },
];

/** The engine's key (env-or-file; env wins) — null when the engine is
 *  not keyed, which by owner decision means NOT LIVE. */
function engineKey(id: "tavily" | "brave"): string | null {
	const envVar = ENGINE_ORDER.find((e) => e.id === id)?.envVar;
	const value = envVar ? keyValue(envVar) : undefined;
	return value ? value : null;
}

/** A configured Firecrawl server, or a reason the configured URL is unusable.
 *  null = not configured (the app keeps today's search and page reader). */
export type FirecrawlConfig = { apiUrl: string; apiKey?: string } | { error: string };

export function readFirecrawlConfig(): FirecrawlConfig | null {
	const raw = keyValue("FIRECRAWL_API_URL");
	if (!raw?.trim()) return null;
	const apiUrl = normalizeFirecrawlApiUrl(raw);
	if (!apiUrl) return { error: "FIRECRAWL_API_URL is not a valid http(s) URL" };
	const apiKey = keyValue("FIRECRAWL_API_KEY")?.trim() || undefined;
	return { apiUrl, apiKey };
}

/** Resolve the search state PURELY from the given pins (testable): the
 *  explicit engine (if pinned) wins but must be configured; absent pin →
 *  first keyed engine in preference order, then Firecrawl when its URL
 *  is set. Never throws. `apiUrl` is set only when the active engine is
 *  Firecrawl. */
export function resolveSearchEngineFor(
	pinned: SearchEngineId | undefined,
	/** Per-engine live keys (absent engine = absent property is fine). */
	keys: Partial<Record<"tavily" | "brave", string | undefined>>,
	firecrawl?: FirecrawlConfig | null,
): SearchStatus & { key: string | null; apiUrl: string | null } {
	if (pinned === "firecrawl") {
		if (!firecrawl) {
			return {
				available: false,
				engine: null,
				reason: 'search engine is set to "firecrawl" but FIRECRAWL_API_URL is missing',
				key: null,
				apiUrl: null,
			};
		}
		if ("error" in firecrawl) {
			return { available: false, engine: null, reason: firecrawl.error, key: null, apiUrl: null };
		}
		return {
			available: true,
			engine: "firecrawl",
			reason: "search engine: firecrawl (chosen)",
			key: firecrawl.apiKey ?? null,
			apiUrl: firecrawl.apiUrl,
		};
	}
	const pinnedKey = pinned ? keys[pinned] ?? null : null;
	if (pinned) {
		if (!pinnedKey) {
			return {
				available: false,
				engine: null,
				reason: `search engine is set to "${pinned}" but its API key is missing — set the ${pinned === "tavily" ? "TAVILY_API_KEY" : "BRAVE_API_KEY"} key`,
				key: null,
				apiUrl: null,
			};
		}
		return { available: true, engine: pinned, reason: `search engine: ${pinned} (chosen)`, key: pinnedKey, apiUrl: null };
	}
	for (const { id } of ENGINE_ORDER) {
		const key = keys[id] ?? null;
		if (key) return { available: true, engine: id, reason: `search engine: ${id} (auto)`, key, apiUrl: null };
	}
	if (firecrawl && "apiUrl" in firecrawl) {
		return {
			available: true,
			engine: "firecrawl",
			reason: "search engine: firecrawl (auto)",
			key: firecrawl.apiKey ?? null,
			apiUrl: firecrawl.apiUrl,
		};
	}
	if (firecrawl && "error" in firecrawl) {
		return { available: false, engine: null, reason: firecrawl.error, key: null, apiUrl: null };
	}
	return {
		available: false,
		engine: null,
		reason: "no search engine configured — set a Tavily or Brave search API key",
		key: null,
		apiUrl: null,
	};
}

/** The live search state (the honest availability signal): reads the
 *  settings record's pin + the auth store fresh each call, so a key saved
 *  mid-session activates on the next check (no restart). */
export function searchStatus(): SearchStatus {
	const { available, engine, reason } = resolveSearchEngineFor(
		effectiveSettings().agent.search?.engine,
		{
			tavily: engineKey("tavily") ?? undefined,
			brave: engineKey("brave") ?? undefined,
		},
		readFirecrawlConfig(),
	);
	return { available, engine, reason };
}

/** Search available at all? (the settings UI's gray-out signal + the
 *  researcher's enable/disable pin — Teacher stream's rewiring reads this.) */
export function searchAvailable(): boolean {
	return searchStatus().available;
}

/** The LIVE adapter, or null when unavailable. Composed fresh each call —
 *  the tool layer (Teacher stream) calls this once per search, so key
 *  rotations take effect immediately. */
export function searchProvider(): SearchProvider | null {
	const resolved = resolveSearchEngineFor(effectiveSettings().agent.search?.engine, {
		tavily: engineKey("tavily") ?? undefined,
		brave: engineKey("brave") ?? undefined,
	}, readFirecrawlConfig());
	if (!resolved.available || !resolved.engine) {
		// A configured-but-unusable Firecrawl URL should say so. Unset stays
		// the honest "no search engine" result the tool already returns.
		if (resolved.reason.includes("FIRECRAWL_API_URL")) {
			return { id: "firecrawl", async search() { throw new Error(resolved.reason); } };
		}
		return null;
	}
	if (resolved.engine === "tavily" && resolved.key) return tavilyProvider(resolved.key);
	if (resolved.engine === "brave" && resolved.key) return braveProvider(resolved.key);
	if (resolved.engine === "firecrawl" && resolved.apiUrl) return firecrawlProvider(resolved.apiUrl, resolved.key ?? undefined);
	return null;
}

const SCRAPE_TIMEOUT_MS = 25_000;
const SEARCH_TIMEOUT_MS = 30_000;
const MAX_FIRECRAWL_BODY = 5 * 1024 * 1024;

/** Negative search probes, so a server without SearxNG is not hit on every query. */
const searchUnsupportedUntil = new Map<string, number>();
const SEARCH_UNSUPPORTED_TTL_MS = 10 * 60_000;

/** Test seam — the unsupported-search cache is process-wide. */
export function resetFirecrawlSearchCache(): void {
	searchUnsupportedUntil.clear();
}

function firecrawlHeaders(apiKey?: string): Record<string, string> {
	const headers: Record<string, string> = { accept: "application/json", "content-type": "application/json" };
	if (apiKey) headers.authorization = `Bearer ${apiKey}`;
	return headers;
}

function firecrawlFailure(err: unknown, apiUrl: string, what: string): Error {
	if (err instanceof FirecrawlSearchUnsupportedError) return err;
	if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
		return new Error(`Firecrawl ${what} timed out`);
	}
	const message = err instanceof Error ? err.message : String(err);
	if (/redirect/i.test(message)) {
		return new Error(`Firecrawl ${what} was redirected; FIRECRAWL_API_URL should be the server root (${apiUrl})`);
	}
	return new Error(`could not reach Firecrawl at ${apiUrl}: ${message}`);
}

async function readFirecrawlBody(resp: Response): Promise<string> {
	const length = Number(resp.headers.get("content-length") ?? 0);
	if (Number.isFinite(length) && length > MAX_FIRECRAWL_BODY) throw new Error("Firecrawl response too large");
	const text = await resp.text();
	if (text.length > MAX_FIRECRAWL_BODY) throw new Error("Firecrawl response too large");
	return text;
}

/**
 * Firecrawl, beside Tavily and Brave. `search` is POST /v1/search.
 * `scrape` is POST /v1/scrape and is what web_fetch uses whenever the
 * URL is configured, even when another engine owns web_search.
 * No Authorization header when apiKey is omitted.
 */
export function firecrawlProvider(apiUrl: string, apiKey?: string, fetchFn: FetchLike = fetch): SearchProvider & PageReader {
	const headers = firecrawlHeaders(apiKey);
	return {
		id: "firecrawl",
		async search(query: string, count: number): Promise<SearchHit[]> {
			const blocked = searchUnsupportedUntil.get(apiUrl) ?? 0;
			if (blocked > Date.now()) throw new FirecrawlSearchUnsupportedError();
			let resp: Response;
			try {
				resp = await fetchFn(`${apiUrl}/v1/search`, {
					method: "POST",
					headers,
					body: JSON.stringify({ query, limit: Math.min(Math.max(count, 1), 10) }),
					redirect: "error",
					signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
				});
			} catch (err) {
				throw firecrawlFailure(err, apiUrl, "search");
			}
			const body = await readFirecrawlBody(resp);
			try {
				const hits = parseFirecrawlSearch(resp.status, body);
				searchUnsupportedUntil.delete(apiUrl);
				return hits;
			} catch (err) {
				if (err instanceof FirecrawlSearchUnsupportedError) {
					searchUnsupportedUntil.set(apiUrl, Date.now() + SEARCH_UNSUPPORTED_TTL_MS);
				}
				throw err;
			}
		},
		async scrape(url: string, signal?: AbortSignal): Promise<ScrapedPage> {
			const timeout = AbortSignal.timeout(SCRAPE_TIMEOUT_MS);
			const combined = signal && typeof AbortSignal.any === "function" ? AbortSignal.any([signal, timeout]) : timeout;
			let resp: Response;
			try {
				resp = await fetchFn(`${apiUrl}/v1/scrape`, {
					method: "POST",
					headers,
					body: JSON.stringify({ url, formats: ["markdown"] }),
					redirect: "error",
					signal: combined,
				});
			} catch (err) {
				throw firecrawlFailure(err, apiUrl, "scrape");
			}
			return parseFirecrawlScrape(resp.status, await readFirecrawlBody(resp), url);
		},
	};
}

/** The page reader for web_fetch. null when Firecrawl is unset — web_fetch
 *  then keeps the built-in reader. A set-but-invalid URL still returns a
 *  reader so the tool can say what is wrong instead of silently ignoring it. */
export function firecrawlPageReader(fetchFn: FetchLike = fetch): PageReader | null {
	const cfg = readFirecrawlConfig();
	if (!cfg) return null;
	if ("error" in cfg) {
		const message = cfg.error;
		return { async scrape() { throw new Error(message); } };
	}
	const provider = firecrawlProvider(cfg.apiUrl, cfg.apiKey, fetchFn);
	return { scrape: (url, signal) => provider.scrape(url, signal) };
}
