/**
 * Firecrawl wire shapes (self-hosted v1). Pure: no fetch, no env.
 *
 * The live adapter sits next to Brave in src/server/search.ts. The
 * researcher does not import that module. FIRECRAWL_API_URL is the
 * switch (same role BRAVE_API_KEY plays for Brave). The API key is
 * optional — a server with authentication off needs only the URL.
 *
 * Scrape is the capability his server is known to have:
 *   POST {apiUrl}/v1/scrape  { url, formats: ["markdown"] }
 *   → { success: true, data: { markdown, metadata } }
 * Search (POST /v1/search) is optional. A missing SearxNG endpoint is
 * FirecrawlSearchUnsupportedError, not a scrape failure.
 */

/** What web_fetch turns into the researcher's markdown. */
export interface ScrapedPage {
	markdown: string;
	title?: string;
	sourceUrl: string;
	statusCode?: number;
	contentType?: string;
}

/** One page reader. `scrape` throws Error with a short message. */
export interface PageReader {
	scrape(url: string, signal?: AbortSignal): Promise<ScrapedPage>;
}

/** Search rows in the same shape as core/search.ts SearchHit. */
export interface FirecrawlSearchHit {
	title: string;
	url: string;
	snippet: string;
}

/** The Firecrawl server answered, and search is not set up on it. */
export class FirecrawlSearchUnsupportedError extends Error {
	constructor() {
		super("Firecrawl search is not configured on this server");
		this.name = "FirecrawlSearchUnsupportedError";
	}
}

/**
 * Server root, no trailing slash. Accepts the origin (`http://host:3002`)
 * or the same origin with a trailing `/v1` or `/v1/scrape` pasted from a
 * doc. Empty string when the value is not an http(s) URL, or when it
 * carries a username, password, query, or fragment (the key does not
 * belong in the URL).
 */
export function normalizeFirecrawlApiUrl(raw: string): string {
	const value = raw.trim();
	if (!value) return "";
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return "";
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return "";
	if (url.username || url.password || url.search || url.hash || value.includes("?") || value.includes("#")) return "";
	return url.toString().replace(/\/+$/, "").replace(/\/v1(?:\/(?:scrape|search|crawl|map))?$/i, "");
}

function errorText(status: number, body: string, parsed: unknown): string {
	if (parsed && typeof parsed === "object" && "error" in parsed && typeof (parsed as { error?: unknown }).error === "string") {
		const message = (parsed as { error: string }).error.trim();
		if (message) return message.slice(0, 300);
	}
	const slice = body.trim().slice(0, 300);
	return slice || `HTTP ${status}`;
}

export function firecrawlSearchUnsupported(status: number, text: string): boolean {
	if (status === 404) return true;
	return /searxng|search endpoint is not configured|search is not configured/i.test(text);
}

function searchRows(data: unknown): Array<{ url?: unknown; title?: unknown; description?: unknown; snippet?: unknown }> {
	if (Array.isArray(data)) return data;
	if (data && typeof data === "object") {
		const record = data as { web?: unknown; results?: unknown };
		if (Array.isArray(record.web)) return record.web;
		if (Array.isArray(record.results)) return record.results;
	}
	return [];
}

/** Map a /v1/search body to hits, or throw. */
export function parseFirecrawlSearch(status: number, body: string): FirecrawlSearchHit[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		if (firecrawlSearchUnsupported(status, body)) throw new FirecrawlSearchUnsupportedError();
		throw new Error(`Firecrawl search failed (${status}): ${body.trim().slice(0, 300) || "non-JSON body"}`);
	}
	const message = errorText(status, body, parsed);
	if (firecrawlSearchUnsupported(status, `${message}\n${body}`)) throw new FirecrawlSearchUnsupportedError();
	const success = parsed && typeof parsed === "object" && "success" in parsed ? (parsed as { success?: unknown }).success : undefined;
	if (status >= 400 || success === false) throw new Error(`Firecrawl search failed (${status}): ${message}`);
	const data = parsed && typeof parsed === "object" && "data" in parsed ? (parsed as { data?: unknown }).data : undefined;
	return searchRows(data)
		.filter((row) => typeof row.url === "string" && row.url)
		.map((row) => ({
			title: typeof row.title === "string" && row.title ? row.title : String(row.url),
			url: String(row.url),
			snippet: (typeof row.description === "string" ? row.description : typeof row.snippet === "string" ? row.snippet : "")
				.replace(/\n/g, " ")
				.slice(0, 500),
		}));
}

function metaString(meta: Record<string, unknown>, ...keys: string[]): string | undefined {
	for (const key of keys) {
		const value = meta[key];
		if (typeof value === "string" && value.trim()) return value;
	}
	return undefined;
}

/** Map a /v1/scrape body to a page, or throw. */
export function parseFirecrawlScrape(status: number, body: string, requestedUrl: string): ScrapedPage {
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		throw new Error(`Firecrawl scrape failed (${status}): ${body.trim().slice(0, 300) || "non-JSON body"}`);
	}
	const message = errorText(status, body, parsed);
	const success = parsed && typeof parsed === "object" && "success" in parsed ? (parsed as { success?: unknown }).success : undefined;
	if (status >= 400 || success === false) throw new Error(`Firecrawl scrape failed (${status}): ${message}`);
	const data = parsed && typeof parsed === "object" && "data" in parsed ? (parsed as { data?: unknown }).data : undefined;
	if (!data || typeof data !== "object") throw new Error("Firecrawl scrape returned no page data");
	const record = data as { markdown?: unknown; metadata?: unknown };
	const meta = record.metadata && typeof record.metadata === "object" ? record.metadata as Record<string, unknown> : {};
	const contentType = metaString(meta, "contentType", "content_type");
	const markdown = typeof record.markdown === "string" ? record.markdown : "";
	const isPdf = (contentType ?? "").toLowerCase().includes("pdf");
	if (!isPdf && markdown.trim().length === 0) throw new Error("Firecrawl scrape returned no readable markdown");
	const statusCode = typeof meta.statusCode === "number" ? meta.statusCode : typeof meta.pageStatusCode === "number" ? meta.pageStatusCode : undefined;
	return {
		markdown,
		title: metaString(meta, "title", "ogTitle"),
		sourceUrl: metaString(meta, "sourceURL", "sourceUrl", "url") ?? requestedUrl,
		statusCode,
		contentType,
	};
}
