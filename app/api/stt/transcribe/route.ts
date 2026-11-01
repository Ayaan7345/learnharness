/**
 * POST /api/stt/transcribe — speech-to-text through OpenRouter.
 *
 * Body: `{ pcm: "<base64 linear16 16 kHz mono>", language }`.
 * The handler wraps a WAV and calls OpenRouter's Deepgram Nova-3
 * transcription API with the server's OPENROUTER_API_KEY. The response
 * is `{ text }`. The key is never copied into the response.
 */
import { transcribeWithOpenRouter } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return Response.json({ message: "Invalid JSON" }, { status: 400 });
	}
	const result = await transcribeWithOpenRouter(body);
	if (!result.ok) return Response.json({ message: result.message }, { status: result.status });
	return Response.json({ text: result.text });
}
