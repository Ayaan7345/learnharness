/**
 * Speech-to-text shapes for OpenRouter's Deepgram Nova-3 route.
 *
 * OpenRouter lists Deepgram as a provider and serves Nova-3, a speech-to-text
 * model, at POST /api/v1/audio/transcriptions
 * (https://openrouter.ai/provider/deepgram, https://openrouter.ai/deepgram/nova-3,
 * https://openrouter.ai/docs/guides/overview/multimodal/stt).
 * That API transcribes one base64 audio payload. It is not Deepgram's
 * streaming WebSocket. The browser captures linear16 16 kHz mono PCM; the
 * server wraps a WAV and calls OpenRouter. The OpenRouter key never leaves
 * the server.
 *
 * `language` on that API is an ISO-639-1 code. Dictation locales keep their
 * primary subtag (`en-US` → `en`). `multi` omits `language` and sets
 * Deepgram's `detect_language`. The direct Deepgram stream, used only when
 * no OpenRouter key is set, still sends the full Nova-3 code.
 */
import { isDictationLanguage, type DictationLanguage } from "./dictation.ts";

export const OPENROUTER_STT_MODEL = "deepgram/nova-3";
export const OPENROUTER_STT_URL = "https://openrouter.ai/api/v1/audio/transcriptions";

/** Capture format shared with the AudioWorklet and the direct Deepgram stream. */
export const STT_SAMPLE_RATE = 16000;

/** Ten minutes of 16 kHz 16-bit mono. Longer captures are refused before upload. */
export const STT_MAX_PCM_BYTES = 10 * 60 * STT_SAMPLE_RATE * 2;

export type SttEngine = "openrouter" | "deepgram";

export function isSttEngine(value: unknown): value is SttEngine {
	return value === "openrouter" || value === "deepgram";
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function bytesToBase64(bytes: Uint8Array): string {
	let out = "";
	for (let i = 0; i < bytes.length; i += 3) {
		const a = bytes[i]!;
		const b = i + 1 < bytes.length ? bytes[i + 1]! : 0;
		const c = i + 2 < bytes.length ? bytes[i + 2]! : 0;
		const triple = (a << 16) | (b << 8) | c;
		out += B64[(triple >> 18) & 63]!
			+ B64[(triple >> 12) & 63]!
			+ (i + 1 < bytes.length ? B64[(triple >> 6) & 63]! : "=")
			+ (i + 2 < bytes.length ? B64[triple & 63]! : "=");
	}
	return out;
}

export function concatBytes(frames: ArrayBuffer[]): Uint8Array {
	let length = 0;
	for (const frame of frames) length += frame.byteLength;
	const out = new Uint8Array(length);
	let offset = 0;
	for (const frame of frames) {
		const view = new Uint8Array(frame);
		out.set(view, offset);
		offset += view.byteLength;
	}
	return out;
}

/** Standard base64. Null when the alphabet, padding, or length is wrong. */
export function decodeBase64(value: string): Uint8Array | null {
	if (value.length === 0 || value.length % 4 !== 0) return null;
	if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return null;
	const pad = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
	const out = new Uint8Array((value.length / 4) * 3 - pad);
	let o = 0;
	for (let i = 0; i < value.length; i += 4) {
		const a = B64.indexOf(value[i]!);
		const b = B64.indexOf(value[i + 1]!);
		const cChar = value[i + 2]!;
		const dChar = value[i + 3]!;
		const c = cChar === "=" ? 0 : B64.indexOf(cChar);
		const d = dChar === "=" ? 0 : B64.indexOf(dChar);
		if (a < 0 || b < 0 || (cChar !== "=" && c < 0) || (dChar !== "=" && d < 0)) return null;
		const triple = (a << 18) | (b << 12) | (c << 6) | d;
		out[o++] = (triple >> 16) & 255;
		if (cChar !== "=") out[o++] = (triple >> 8) & 255;
		if (dChar !== "=") out[o++] = triple & 255;
	}
	return out;
}

export function pcm16ToWav(pcm: Uint8Array, sampleRate = STT_SAMPLE_RATE): Uint8Array {
	const header = new ArrayBuffer(44);
	const view = new DataView(header);
	const write = (offset: number, text: string) => {
		for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
	};
	const dataSize = pcm.byteLength;
	write(0, "RIFF");
	view.setUint32(4, 36 + dataSize, true);
	write(8, "WAVE");
	write(12, "fmt ");
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, 1, true);
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * 2, true);
	view.setUint16(32, 2, true);
	view.setUint16(34, 16, true);
	write(36, "data");
	view.setUint32(40, dataSize, true);
	const wav = new Uint8Array(44 + dataSize);
	wav.set(new Uint8Array(header), 0);
	wav.set(pcm, 44);
	return wav;
}

/** OpenRouter's language field plus Deepgram's detect_language option. */
export function openRouterLanguage(language: DictationLanguage): { language?: string; detectLanguage: boolean } {
	if (language === "multi") return { detectLanguage: true };
	return { language: language.split("-")[0]!.toLowerCase(), detectLanguage: false };
}

export function openRouterTranscriptionBody(wavBase64: string, language: DictationLanguage): {
	model: typeof OPENROUTER_STT_MODEL;
	input_audio: { data: string; format: "wav" };
	language?: string;
	provider: { options: { deepgram: { punctuate: true; smart_format: true; detect_language: boolean } } };
} {
	const mapped = openRouterLanguage(language);
	return {
		model: OPENROUTER_STT_MODEL,
		input_audio: { data: wavBase64, format: "wav" },
		...(mapped.language ? { language: mapped.language } : {}),
		provider: {
			options: {
				deepgram: {
					punctuate: true,
					smart_format: true,
					detect_language: mapped.detectLanguage,
				},
			},
		},
	};
}

export type TranscriptionRequest =
	| { ok: true; pcm: Uint8Array; language: DictationLanguage }
	| { ok: false; status: 400 | 413; message: string };

/** Validate a client body before any provider call. Never reads a key. */
export function parseTranscriptionRequest(body: unknown): TranscriptionRequest {
	if (!body || typeof body !== "object" || Array.isArray(body)) {
		return { ok: false, status: 400, message: "Expected a JSON object" };
	}
	const record = body as { pcm?: unknown; language?: unknown };
	if (typeof record.pcm !== "string") return { ok: false, status: 400, message: "Expected pcm as base64" };
	if (!isDictationLanguage(record.language)) return { ok: false, status: 400, message: "Unsupported dictation language" };
	const maxBase64 = Math.ceil(STT_MAX_PCM_BYTES / 3) * 4;
	if (record.pcm.length > maxBase64) return { ok: false, status: 413, message: "Dictation audio is too long" };
	const pcm = decodeBase64(record.pcm);
	if (!pcm || pcm.byteLength === 0 || pcm.byteLength % 2 !== 0) {
		return { ok: false, status: 400, message: "Expected non-empty 16-bit PCM as base64" };
	}
	if (pcm.byteLength > STT_MAX_PCM_BYTES) return { ok: false, status: 413, message: "Dictation audio is too long" };
	return { ok: true, pcm, language: record.language };
}
