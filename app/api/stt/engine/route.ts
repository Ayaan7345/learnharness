/**
 * GET /api/stt/engine — which dictation engine the server can run.
 * `{ engine: "openrouter" | "deepgram" }`. Never a key.
 * 503 when neither OPENROUTER_API_KEY nor DEEPGRAM_API_KEY is set.
 * OpenRouter wins so dictation uses the key the app already has.
 */
import { sttEngine } from "@/src/server";

export const dynamic = "force-dynamic";

export function GET() {
	const engine = sttEngine();
	if (!engine) {
		return Response.json(
			{ message: "No transcription key — set OPENROUTER_API_KEY or DEEPGRAM_API_KEY." },
			{ status: 503 },
		);
	}
	return Response.json({ engine });
}
