/**
 * OpenRouter Deepgram Nova-3 transcription. The provider call is stubbed;
 * these tests never touch the network. The key is read the same way as
 * every other server secret (keyValue) and must not come back to the client.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import packageMetadata from "../package.json" with { type: "json" };
import {
	OPENROUTER_STT_MODEL,
	OPENROUTER_STT_URL,
	STT_MAX_PCM_BYTES,
	bytesToBase64,
	decodeBase64,
	openRouterLanguage,
	openRouterTranscriptionBody,
	parseTranscriptionRequest,
	pcm16ToWav,
} from "../src/core/stt.ts";

const dir = mkdtempSync(path.join(tmpdir(), "lh-stt-"));
const saved = {
	data: process.env.LH_DATA_DIR,
	auth: process.env.LH_AUTH_FILE,
	openrouter: process.env.OPENROUTER_API_KEY,
	deepgram: process.env.DEEPGRAM_API_KEY,
};
process.env.LH_DATA_DIR = dir;
process.env.LH_AUTH_FILE = path.join(dir, "auth.json");
delete process.env.OPENROUTER_API_KEY;
delete process.env.DEEPGRAM_API_KEY;

const { sttEngine, transcribeWithOpenRouter } = await import("../src/server/stt.ts");
const engineRoute = await import("../app/api/stt/engine/route.ts");
const transcribeRoute = await import("../app/api/stt/transcribe/route.ts");

after(() => {
	restore("LH_DATA_DIR", saved.data);
	restore("LH_AUTH_FILE", saved.auth);
	restore("OPENROUTER_API_KEY", saved.openrouter);
	restore("DEEPGRAM_API_KEY", saved.deepgram);
	rmSync(dir, { recursive: true, force: true });
});

function restore(name: string, value: string | undefined) {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

const KEY = "sk-or-test-secret-value";
const PCM = new Uint8Array([1, 2, 3, 4, 5, 6]);

describe("OpenRouter transcription request", () => {
	it("wraps linear16 PCM in a 16 kHz mono WAV", () => {
		const wav = pcm16ToWav(PCM);
		assert.equal(wav.byteLength, 44 + PCM.byteLength);
		const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
		assert.equal(String.fromCharCode(...wav.subarray(0, 4)), "RIFF");
		assert.equal(String.fromCharCode(...wav.subarray(8, 12)), "WAVE");
		assert.equal(view.getUint16(20, true), 1);
		assert.equal(view.getUint16(22, true), 1);
		assert.equal(view.getUint32(24, true), 16000);
		assert.equal(view.getUint16(34, true), 16);
		assert.equal(view.getUint32(40, true), PCM.byteLength);
		assert.deepEqual(wav.subarray(44), PCM);
		assert.deepEqual(decodeBase64(bytesToBase64(wav)), wav);
	});

	it("targets Deepgram Nova-3 and maps locales to ISO-639-1", () => {
		assert.deepEqual(openRouterLanguage("en-US"), { language: "en", detectLanguage: false });
		assert.deepEqual(openRouterLanguage("pt-BR"), { language: "pt", detectLanguage: false });
		assert.deepEqual(openRouterLanguage("zh-HK"), { language: "zh", detectLanguage: false });
		assert.deepEqual(openRouterLanguage("multi"), { detectLanguage: true });
		const body = openRouterTranscriptionBody("QQ==", "en-GB");
		assert.equal(body.model, OPENROUTER_STT_MODEL);
		assert.equal(body.model, "deepgram/nova-3");
		assert.equal(body.language, "en");
		assert.equal(body.input_audio.format, "wav");
		assert.equal(body.provider.options.deepgram.punctuate, true);
		assert.equal(body.provider.options.deepgram.smart_format, true);
		assert.equal(body.provider.options.deepgram.detect_language, false);
		const multi = openRouterTranscriptionBody("QQ==", "multi");
		assert.equal("language" in multi, false);
		assert.equal(multi.provider.options.deepgram.detect_language, true);
	});

	it("rejects empty, odd, unknown-language, and over-long audio before any provider call", () => {
		assert.equal(parseTranscriptionRequest(null).ok, false);
		assert.equal(parseTranscriptionRequest({ pcm: bytesToBase64(PCM), language: "nope" }).ok, false);
		assert.equal(parseTranscriptionRequest({ pcm: bytesToBase64(new Uint8Array([1])), language: "en" }).ok, false);
		assert.equal(parseTranscriptionRequest({ pcm: "", language: "en" }).ok, false);
		const accepted = parseTranscriptionRequest({ pcm: bytesToBase64(PCM), language: "pl" });
		assert.equal(accepted.ok, true);
		if (accepted.ok) assert.deepEqual(accepted.pcm, PCM);
		const tooLong = parseTranscriptionRequest({ pcm: "A".repeat(Math.ceil(STT_MAX_PCM_BYTES / 3) * 4 + 4), language: "en" });
		assert.equal(tooLong.ok, false);
		if (!tooLong.ok) assert.equal(tooLong.status, 413);
	});
});

describe("transcription engine", { concurrency: false }, () => {
	it("prefers OpenRouter and falls back to a direct Deepgram key only when OpenRouter is unset", () => {
		delete process.env.OPENROUTER_API_KEY;
		delete process.env.DEEPGRAM_API_KEY;
		assert.equal(sttEngine(), null);
		process.env.DEEPGRAM_API_KEY = "direct-deepgram-key-value";
		assert.equal(sttEngine(), "deepgram");
		process.env.OPENROUTER_API_KEY = KEY;
		assert.equal(sttEngine(), "openrouter", "an OpenRouter key wins even when a Deepgram key is also set");
	});

	it("GET /api/stt/engine reports the same choice and never a secret", async () => {
		delete process.env.OPENROUTER_API_KEY;
		delete process.env.DEEPGRAM_API_KEY;
		const missing = await engineRoute.GET();
		assert.equal(missing.status, 503);
		assert.equal(JSON.stringify(await missing.json()).includes("direct-deepgram"), false);
		process.env.DEEPGRAM_API_KEY = "direct-deepgram-key-value";
		assert.deepEqual(await (await engineRoute.GET()).json(), { engine: "deepgram" });
		process.env.OPENROUTER_API_KEY = KEY;
		const body = await (await engineRoute.GET()).json();
		assert.deepEqual(body, { engine: "openrouter" });
		assert.equal(JSON.stringify(body).includes(KEY), false);
	});
});

describe("POST /api/stt/transcribe", { concurrency: false }, () => {
	it("calls OpenRouter with the server key and returns only text", async () => {
		process.env.OPENROUTER_API_KEY = KEY;
		let captured: { url: string; init: RequestInit } | undefined;
		const result = await transcribeWithOpenRouter(
			{ pcm: bytesToBase64(PCM), language: "en-US" },
			async (url, init) => {
				captured = { url, init };
				return Response.json({ text: "  hello there  " });
			},
		);
		assert.deepEqual(result, { ok: true, text: "hello there" });
		assert.ok(captured);
		assert.equal(captured!.url, OPENROUTER_STT_URL);
		assert.equal(captured!.init.method, "POST");
		const headers = captured!.init.headers as Record<string, string>;
		assert.equal(headers.Authorization, `Bearer ${KEY}`);
		assert.equal(headers["HTTP-Referer"], packageMetadata.homepage);
		assert.equal(headers["X-OpenRouter-Title"], packageMetadata.name);
		const sent = JSON.parse(captured!.init.body as string) as {
			model: string;
			language: string;
			input_audio: { data: string; format: string };
			provider: { options: { deepgram: { punctuate: boolean; smart_format: boolean; detect_language: boolean } } };
		};
		assert.equal(sent.model, "deepgram/nova-3");
		assert.equal(sent.language, "en");
		assert.equal(sent.input_audio.format, "wav");
		assert.equal(sent.provider.options.deepgram.detect_language, false);
		assert.equal(JSON.stringify(sent).includes(KEY), false);
		const wav = decodeBase64(sent.input_audio.data);
		assert.ok(wav);
		assert.equal(String.fromCharCode(...wav!.subarray(0, 4)), "RIFF");
		assert.deepEqual(wav!.subarray(44), PCM);
	});

	it("the route returns text, hides the key, and refuses a missing key or bad JSON", async () => {
		process.env.OPENROUTER_API_KEY = KEY;
		const realFetch = globalThis.fetch;
		globalThis.fetch = (async () => new Response(JSON.stringify({ text: "from nova", echo: KEY }), {
			status: 200,
			headers: { "content-type": "application/json" },
		})) as typeof fetch;
		try {
			const ok = await transcribeRoute.POST(new Request("http://localhost/api/stt/transcribe", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ pcm: bytesToBase64(PCM), language: "pl" }),
			}));
			assert.equal(ok.status, 200);
			const payload = await ok.json() as { text: string };
			assert.deepEqual(payload, { text: "from nova" });
			assert.equal(JSON.stringify(payload).includes(KEY), false);
		} finally {
			globalThis.fetch = realFetch;
		}

		delete process.env.OPENROUTER_API_KEY;
		const missing = await transcribeRoute.POST(new Request("http://localhost/api/stt/transcribe", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ pcm: bytesToBase64(PCM), language: "en" }),
		}));
		assert.equal(missing.status, 503);
		assert.equal(JSON.stringify(await missing.json()).includes(KEY), false);

		process.env.OPENROUTER_API_KEY = KEY;
		const bad = await transcribeRoute.POST(new Request("http://localhost/api/stt/transcribe", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{",
		}));
		assert.equal(bad.status, 400);
	});

	it("upstream failures are 502 and the key is redacted from the provider body", async () => {
		process.env.OPENROUTER_API_KEY = KEY;
		const failed = await transcribeWithOpenRouter(
			{ pcm: bytesToBase64(PCM), language: "en" },
			async () => new Response(`unauthorized ${KEY}`, { status: 401 }),
		);
		assert.equal(failed.ok, false);
		if (!failed.ok) {
			assert.equal(failed.status, 502);
			assert.match(failed.message, /401/);
			assert.equal(failed.message.includes(KEY), false);
			assert.match(failed.message, /\[redacted\]/);
		}
		const down = await transcribeWithOpenRouter(
			{ pcm: bytesToBase64(PCM), language: "en" },
			async () => { throw new Error(`network ${KEY}`); },
		);
		assert.deepEqual(down, { ok: false, status: 502, message: "OpenRouter unreachable" });
	});
});
