/**
 * Server Jev calls (core/jev.ts holds the shapes). Every call goes to
 * OpenRouter's System One route with the server's OPENROUTER_API_KEY — the
 * key never leaves the server — and FAILS OPEN: no key, a timeout, an HTTP
 * error or an unreadable body leaves the lesson exactly as it would run
 * without Jev, with a warning in the log.
 *
 * - jevBeforeToolCall: the agent's beforeToolCall hook — the tool guard
 *   and the quiz answer-key check, asked in ONE request per call.
 * - withJevUnderstanding: attaches the understanding hint to a turn's
 *   incoming explain answers and practice submissions before they persist.
 */
import type { AgentMessage, BeforeToolCallContext, BeforeToolCallResult } from "@earendil-works/pi-agent-core";
import packageMetadata from "../../package.json" with { type: "json" };
import {
	JEV_TIMEOUT_MS,
	JEV_URL,
	jevRequestBody,
	jevToolCallRequest,
	jevToolCallVerdict,
	parseJevAnswers,
	understandingHint,
	understandingOf,
	understandingRequest,
	type JevAnswer,
	type JevPhase,
	type JevQuestion,
	type JevUnderstanding,
	type UnderstandingInput,
} from "../core/jev.ts";
import type { LhMarkerMessage, LhMessage } from "../core/native-messages.ts";
import { compactAnswerForModel, type QuestionAnswerData } from "../core/question-core.ts";
import { toolQuestionKind } from "../core/pending.ts";
import { keyValue } from "./keys.ts";

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** Test seam (the toolTimeoutMs idiom): tests swap in a scripted fetch. */
export const jevFetch: { current: FetchLike } = { current: (input, init) => fetch(input, init) };

/** One System One request → its answers, or null (fail open). */
export async function askJev(
	state: unknown,
	questions: Record<string, JevQuestion>,
	signal?: AbortSignal,
): Promise<Record<string, JevAnswer> | null> {
	const key = keyValue("OPENROUTER_API_KEY");
	if (!key) {
		console.warn("[jev] skipped: no OPENROUTER_API_KEY");
		return null;
	}
	const timeout = AbortSignal.timeout(JEV_TIMEOUT_MS);
	try {
		const res = await jevFetch.current(JEV_URL, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${key}`,
				"Content-Type": "application/json",
				"HTTP-Referer": packageMetadata.homepage,
				"X-OpenRouter-Title": packageMetadata.name,
			},
			body: JSON.stringify(jevRequestBody(state, questions)),
			signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
		});
		if (!res.ok) {
			const detail = (await res.text().catch(() => "")).split(key).join("[redacted]").slice(0, 200);
			console.warn(`[jev] HTTP ${res.status}; allowing: ${detail}`);
			return null;
		}
		const answers = parseJevAnswers(await res.json());
		if (!answers) console.warn("[jev] unreadable response; allowing");
		return answers;
	} catch (err) {
		console.warn(`[jev] request failed; allowing: ${err instanceof Error ? err.message : String(err)}`);
		return null;
	}
}

// ─── tool guard + quiz answer-key check ─────────────────────────────────────

/** How many recent messages the guard sees. */
const RECENT_MESSAGES = 8;

function messageText(message: AgentMessage): string {
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block: { type?: string; text?: string; thinking?: string; name?: string; arguments?: unknown }) => {
			if (block.type === "text") return block.text ?? "";
			if (block.type === "toolCall") return `[tool call ${block.name}: ${JSON.stringify(block.arguments ?? {})}]`;
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

function recentConversation(messages: readonly AgentMessage[]): { role: string; text: string }[] {
	return messages
		.filter((m) => m.role !== "system")
		.slice(-RECENT_MESSAGES)
		.map((m) => ({ role: m.role, text: messageText(m) }))
		.filter((m) => m.text.length > 0);
}

/** The agent's beforeToolCall hook, or undefined when both switches are off. */
export function jevBeforeToolCall(opts: {
	phase: JevPhase;
	toolGuard: boolean;
	quizCheck: boolean;
}): ((context: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined>) | undefined {
	if (!opts.toolGuard && !opts.quizCheck) return undefined;
	return async (context, signal) => {
		const request = jevToolCallRequest({
			phase: opts.phase,
			recent: recentConversation(context.context.messages),
			toolName: context.toolCall.name,
			args: context.args,
			toolGuard: opts.toolGuard,
			quizCheck: opts.quizCheck,
		});
		if (!request) return undefined;
		const answers = await askJev(request.state, request.questions, signal);
		if (!answers) return undefined;
		const verdict = jevToolCallVerdict(request, answers);
		if (!verdict.block) return undefined;
		console.info(`[jev] blocked ${context.toolCall.name}: ${verdict.reason}`);
		return { block: true, reason: verdict.reason };
	};
}

// ─── understanding hint ─────────────────────────────────────────────────────

/** The arguments of the tool call `toolCallId` in the record. */
function callArgs(messages: readonly LhMessage[], toolCallId: string): Record<string, unknown> | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i]!;
		if (m.role !== "assistant") continue;
		for (const block of m.content) {
			if (block.type === "toolCall" && block.id === toolCallId) {
				return (block.arguments ?? {}) as Record<string, unknown>;
			}
		}
	}
	return null;
}

const str = (v: unknown) => (typeof v === "string" ? v : "");

/** What Jev judges for one appended message, or null when it is not a
 *  judgeable explain answer or practice submission. */
function understandingInputFor(history: readonly LhMessage[], message: LhMessage): UnderstandingInput | null {
	if (message.role === "toolResult") {
		if (message.isError || toolQuestionKind(message.toolName) !== "explain") return null;
		const answer = message.details as QuestionAnswerData | null | undefined;
		if (!answer || answer.dismissed || answer.dontKnow || !answer.text?.trim()) return null;
		const args = callArgs(history, message.toolCallId);
		if (!args || !str(args.correctAnswer)) return null;
		return {
			question: str(args.question) || answer.questionText,
			reference: str(args.correctAnswer),
			answer: answer.text,
			...(answer.thinking ? { thinking: answer.thinking } : {}),
		};
	}
	if (message.role === "custom" && message.customType === "practice-thinking") {
		const details = message.details as { problemCallId?: unknown; text?: unknown };
		const args = typeof details.problemCallId === "string" ? callArgs(history, details.problemCallId) : null;
		if (!args || !str(args.modelSolution) || !str(details.text).trim()) return null;
		return { question: str(args.statement), reference: str(args.modelSolution), answer: str(details.text) };
	}
	return null;
}

/** The message with Jev's read attached: on `details.jev` for the record,
 *  and in the model-facing content for the teacher. */
function withHint(message: LhMessage, jev: JevUnderstanding): LhMessage {
	if (message.role === "toolResult") {
		const details = { ...(message.details as unknown as QuestionAnswerData), jev };
		return {
			...message,
			details: details as unknown as typeof message.details,
			content: [{ type: "text", text: JSON.stringify(compactAnswerForModel(details)) }],
		};
	}
	const marker = message as LhMarkerMessage;
	return {
		...marker,
		content: `${marker.content}\n\n[Jev understanding: ${understandingHint(jev)}]`,
		details: { ...(marker.details as object), jev },
	};
}

/** Attach the understanding hint to every judgeable message in `appends`
 *  (the requests run in parallel; a failed one leaves its message as is). */
export async function withJevUnderstanding(
	history: readonly LhMessage[],
	appends: LhMessage[],
): Promise<LhMessage[]> {
	return Promise.all(
		appends.map(async (message) => {
			const input = understandingInputFor(history, message);
			if (!input) return message;
			const request = understandingRequest(input);
			const answers = await askJev(request.state, request.questions);
			const jev = answers ? understandingOf(answers) : null;
			return jev ? withHint(message, jev) : message;
		}),
	);
}
