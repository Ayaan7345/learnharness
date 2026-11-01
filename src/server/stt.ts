/**
 * Server speech-to-text. OpenRouter is the engine whenever its key is set:
 * Deepgram Nova-3 is called through OpenRouter's audio transcription API
 * with the same OPENROUTER_API_KEY the model calls already use. The browser
 * only receives `{ engine }` or `{ text }` — never the key.
 *
 * Direct Deepgram remains the fallback when that OpenRouter key is absent.
 * The browser still streams to Deepgram with a short-lived token. Clients
 * that upload a finished recording (the iPhone composer) call the same
 * POST: this module then uses Deepgram's prerecorded listen API with the
 * server's DEEPGRAM_API_KEY. OpenRouter's route can do speech-to-text, so
 * a configured OpenRouter key is not retried against Deepgram.
 */
import packageMetadata from "../../package.json" with { type: "json" };
import {
	OPENROUTER_STT_URL,
	bytesToBase64,
	openRouterTranscriptionBody,
	parseTranscriptionRequest,
	pcm16ToWav,
	type SttEngine,
} from "../core/stt.ts";
import { keyValue } from "./keys.ts";

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** OpenRouter wins when its key is present. Deepgram is the no-OpenRouter fallback. */
export function sttEngine(): SttEngine | null {
	if (keyValue("OPENROUTER_API_KEY")) return "openrouter";
	if (keyValue("DEEPGRAM_API_KEY")) return "deepgram";
	return null;
}

export type TranscribeResult =
	| { ok: true; text: string }
	| { ok: false; status: 400 | 413 | 502 | 503; message: string };

function redact(detail: string, key: string): string {
	return detail.split(key).join("[redacted]").slice(0, 200);
}

export async function transcribeWithOpenRouter(body: unknown, fetchFn: FetchLike = fetch): Promise<TranscribeResult> {
	const key = keyValue("OPENROUTER_API_KEY");
	if (!key) {
		return { ok: false, status: 503, message: "No OPENROUTER_API_KEY — dictation uses the server's OpenRouter key." };
	}
	const parsed = parseTranscriptionRequest(body);
	if (!parsed.ok) return parsed;
	const payload = openRouterTranscriptionBody(bytesToBase64(pcm16ToWav(parsed.pcm)), parsed.language);
	try {
		const res = await fetchFn(OPENROUTER_STT_URL, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${key}`,
				"Content-Type": "application/json",
				"HTTP-Referer": packageMetadata.homepage,
				"X-OpenRouter-Title": packageMetadata.name,
			},
			body: JSON.stringify(payload),
			signal: AbortSignal.timeout(120_000),
		});
		const raw = await res.text();
		if (!res.ok) {
			return { ok: false, status: 502, message: `OpenRouter transcription failed (${res.status}): ${redact(raw, key)}` };
		}
		let data: { text?: unknown };
		try {
			data = JSON.parse(raw) as { text?: unknown };
		} catch {
			return { ok: false, status: 502, message: "OpenRouter transcription returned invalid JSON" };
		}
		if (typeof data.text !== "string") {
			return { ok: false, status: 502, message: "OpenRouter transcription returned no text" };
		}
		return { ok: true, text: data.text.trim() };
	} catch {
		return { ok: false, status: 502, message: "OpenRouter unreachable" };
	}
}

/**
 * Prerecorded Deepgram Nova-3 for an uploaded recording. The key stays
 * here. Used when OPENROUTER_API_KEY is absent and DEEPGRAM_API_KEY is set.
 * https://developers.deepgram.com/reference/speech-to-text/listen-pre-recorded
 */
export async function transcribeWithDeepgram(body: unknown, fetchFn: FetchLike = fetch): Promise<TranscribeResult> {
	const key = keyValue("DEEPGRAM_API_KEY");
	if (!key) {
		return { ok: false, status: 503, message: "No DEEPGRAM_API_KEY — dictation uses the server's Deepgram key." };
	}
	const parsed = parseTranscriptionRequest(body);
	if (!parsed.ok) return parsed;
	const wav = pcm16ToWav(parsed.pcm);
	const url = new URL("https://api.deepgram.com/v1/listen");
	url.searchParams.set("model", "nova-3");
	url.searchParams.set("smart_format", "true");
	url.searchParams.set("punctuate", "true");
	url.searchParams.set("language", parsed.language);
	try {
		const res = await fetchFn(url.toString(), {
			method: "POST",
			headers: { Authorization: `Token ${key}`, "Content-Type": "audio/wav" },
			body: wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength) as ArrayBuffer,
			signal: AbortSignal.timeout(120_000),
		});
		const raw = await res.text();
		if (!res.ok) {
			return { ok: false, status: 502, message: `Deepgram transcription failed (${res.status}): ${redact(raw, key)}` };
		}
		let data: unknown;
		try {
			data = JSON.parse(raw) as unknown;
		} catch {
			return { ok: false, status: 502, message: "Deepgram transcription returned invalid JSON" };
		}
		const text = deepgramTranscript(data);
		if (text === null) return { ok: false, status: 502, message: "Deepgram transcription returned no text" };
		return { ok: true, text };
	} catch {
		return { ok: false, status: 502, message: "Deepgram unreachable" };
	}
}

function deepgramTranscript(body: unknown): string | null {
	if (!body || typeof body !== "object") return null;
	const channels = (body as { results?: { channels?: { alternatives?: { transcript?: unknown }[] }[] } }).results?.channels;
	const transcript = channels?.[0]?.alternatives?.[0]?.transcript;
	return typeof transcript === "string" ? transcript.trim() : null;
}

/** OpenRouter when its key is set, otherwise a direct Deepgram prerecorded call. */
export async function transcribeAudio(body: unknown, fetchFn: FetchLike = fetch): Promise<TranscribeResult> {
	if (keyValue("OPENROUTER_API_KEY")) return transcribeWithOpenRouter(body, fetchFn);
	if (keyValue("DEEPGRAM_API_KEY")) return transcribeWithDeepgram(body, fetchFn);
	return { ok: false, status: 503, message: "No transcription key — set OPENROUTER_API_KEY or DEEPGRAM_API_KEY." };
}
