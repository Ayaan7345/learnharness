/**
 * Jev decision shapes — TypeSafe's System One model, reached through
 * OpenRouter's System One route with the server's OpenRouter key
 * (https://openrouter.ai/docs/guides/community/jev.md,
 * https://docs.typesafe.ai/primitives/choice.md).
 *
 * A request is { model, state, questions }: state is the content Jev
 * judges, questions are named typed questions. A Choice answer carries
 * `choice`, `probabilities` (sums to 1) and `confidence`; a Noul answer
 * carries `noul`, the probability of yes. Answers come back under the
 * question ids.
 *
 * Three uses, each behind its own agent.jev switch (all off by default):
 * - the tool guard: allow or block every agent tool call by whether it
 *   fits the current lesson,
 * - the quiz answer-key check: block a quiz whose correctAnswer Jev
 *   disagrees with, before the learner sees it,
 * - the understanding hint: a 3-level read of explain answers and
 *   practice submissions, handed to the teacher (never the learner).
 *
 * Pure — the fetch lives in server/jev.ts.
 */
import { normalizeOptions, resolveCorrect, type QuizOption } from "./question-core.ts";

export const JEV_MODEL = "typesafe/jev-1.14";
export const JEV_URL = "https://openrouter.ai/api/v1/systemone";
/** Every Jev call fails open past this — a lesson never waits on Jev. */
export const JEV_TIMEOUT_MS = 5_000;
/** Block only when Jev puts more than this on "block". */
export const JEV_BLOCK_THRESHOLD = 0.5;

export type JevPhase = "probe" | "teach" | "practice";

export type JevQuestion =
	| { type: "choice"; instructions: string; criteria: Record<string, string> }
	| { type: "noul"; instructions: string };

export interface JevChoiceAnswer {
	type: "choice";
	choice: string;
	confidence: number;
	probabilities: Record<string, number>;
}

export interface JevNoulAnswer {
	type: "noul";
	noul: number;
}

export type JevAnswer = JevChoiceAnswer | JevNoulAnswer;

export function jevRequestBody(state: unknown, questions: Record<string, JevQuestion>) {
	return { model: JEV_MODEL, state, questions };
}

/** The response's answers, or null when the body is not the documented
 *  shape (the caller fails open). Malformed single answers drop. */
export function parseJevAnswers(body: unknown): Record<string, JevAnswer> | null {
	if (body === null || typeof body !== "object") return null;
	const answers = (body as { answers?: unknown }).answers;
	if (answers === null || typeof answers !== "object" || Array.isArray(answers)) return null;
	const out: Record<string, JevAnswer> = {};
	for (const [id, raw] of Object.entries(answers as Record<string, unknown>)) {
		if (raw === null || typeof raw !== "object") continue;
		const a = raw as Record<string, unknown>;
		if (a.type === "choice" && typeof a.choice === "string" && a.probabilities !== null && typeof a.probabilities === "object") {
			const probabilities: Record<string, number> = {};
			for (const [k, v] of Object.entries(a.probabilities as Record<string, unknown>)) {
				if (typeof v === "number" && Number.isFinite(v)) probabilities[k] = v;
			}
			out[id] = {
				type: "choice",
				choice: a.choice,
				confidence: typeof a.confidence === "number" ? a.confidence : 0,
				probabilities,
			};
		} else if (a.type === "noul" && typeof a.noul === "number" && Number.isFinite(a.noul)) {
			out[id] = { type: "noul", noul: a.noul };
		}
	}
	return out;
}

const choiceOf = (answers: Record<string, JevAnswer>, id: string): JevChoiceAnswer | undefined => {
	const a = answers[id];
	return a?.type === "choice" ? a : undefined;
};

const round2 = (n: number) => Math.round(n * 100) / 100;

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

// ─── tool guard + quiz answer-key check ─────────────────────────────────────

export const GUARD_QUESTION_ID = "fits_lesson";
export const QUIZ_KEY_QUESTION_ID = "quiz_key";
const quizOptionQuestionId = (i: number) => `quiz_option_${i}`;

/** The quiz tools (multiple choice, graded against correctAnswer). */
export const JEV_QUIZ_TOOLS = ["quiz", "probe"] as const;

export interface JevToolCallInput {
	phase: JevPhase;
	/** The recent conversation, oldest first, as role + text. */
	recent: { role: string; text: string }[];
	toolName: string;
	args: unknown;
	toolGuard: boolean;
	quizCheck: boolean;
}

interface QuizKey {
	options: QuizOption[];
	multiSelect: boolean;
	/** The answer key as option values. */
	correct: string[];
}

/** The quiz's options and resolved answer key, or null when the call is
 *  not a gradeable quiz (the quiz's own validation reports that). */
function quizKeyOf(toolName: string, args: unknown): QuizKey | null {
	if (!(JEV_QUIZ_TOOLS as readonly string[]).includes(toolName)) return null;
	if (args === null || typeof args !== "object") return null;
	const a = args as { options?: unknown; multiSelect?: unknown; correctAnswer?: unknown };
	const options = normalizeOptions(a.options as Parameters<typeof normalizeOptions>[0]);
	if (options.length < 2) return null;
	const correctAnswer = a.correctAnswer as string | string[] | undefined;
	const resolved = resolveCorrect(correctAnswer, options);
	if (resolved.error || resolved.indices.length === 0) return null;
	return {
		options,
		multiSelect: a.multiSelect === true,
		correct: resolved.indices.map((i) => options[i - 1]!.value),
	};
}

/** The call as Jev sees it. A quiz's answer key and explanation never go
 *  in: the key check must judge the subject, not copy the key. */
function proposedCallState(toolName: string, args: unknown): { tool: string; arguments: string } {
	let shown = args;
	if ((JEV_QUIZ_TOOLS as readonly string[]).includes(toolName) && args !== null && typeof args === "object") {
		const { correctAnswer: _key, explanation: _why, ...rest } = args as Record<string, unknown>;
		shown = rest;
	}
	let text: string;
	try {
		text = JSON.stringify(shown) ?? "";
	} catch {
		text = String(shown);
	}
	return { tool: toolName, arguments: clip(text, 4_000) };
}

export interface JevToolCallRequest {
	state: unknown;
	questions: Record<string, JevQuestion>;
	quiz: QuizKey | null;
}

/** The one request for a tool call — guard and quiz check together — or
 *  null when neither applies. */
export function jevToolCallRequest(input: JevToolCallInput): JevToolCallRequest | null {
	const questions: Record<string, JevQuestion> = {};
	if (input.toolGuard) {
		questions[GUARD_QUESTION_ID] = {
			type: "choice",
			instructions:
				`An AI tutor in the ${input.phase} phase of a lesson wants to make the tool call in proposedCall. ` +
				"Given the recent conversation, does this call fit the current lesson phase and the learner's goal?",
			criteria: {
				allow: "The call serves the current phase and the learner's goal right now.",
				block:
					"The call does not serve the lesson right now: off-topic, a redundant repeat of a recent call, " +
					"or a question that gives away its own answer.",
			},
		};
	}
	const quiz = input.quizCheck ? quizKeyOf(input.toolName, input.args) : null;
	if (quiz) {
		if (quiz.multiSelect) {
			quiz.options.forEach((option, i) => {
				questions[quizOptionQuestionId(i)] = {
					type: "noul",
					instructions:
						"Judging only on the subject matter, is this option a correct answer to the quiz question in " +
						`proposedCall? Option: ${JSON.stringify(option.label)}`,
				};
			});
		} else {
			questions[QUIZ_KEY_QUESTION_ID] = {
				type: "choice",
				instructions:
					"Judging only on the subject matter, which option correctly answers the quiz question in proposedCall?",
				criteria: Object.fromEntries(quiz.options.map((o) => [o.value, o.label])),
			};
		}
	}
	if (Object.keys(questions).length === 0) return null;
	return {
		state: {
			phase: input.phase,
			recentConversation: input.recent.map((m) => ({ role: m.role, text: clip(m.text, 1_500) })),
			proposedCall: proposedCallState(input.toolName, input.args),
		},
		questions,
		quiz,
	};
}

export type JevToolCallVerdict = { block: false } | { block: true; reason: string };

const quoteOptions = (values: readonly string[], options: readonly QuizOption[]) =>
	values.length === 0
		? "no option"
		: values
				.map((v) => {
					const label = options.find((o) => o.value === v)?.label ?? v;
					return label === v ? `"${v}"` : `"${v}" (${label})`;
				})
				.join(", ");

/** Read Jev's answers into allow/block. A missing answer allows (fail open). */
export function jevToolCallVerdict(request: JevToolCallRequest, answers: Record<string, JevAnswer>): JevToolCallVerdict {
	const guard = choiceOf(answers, GUARD_QUESTION_ID);
	if (request.questions[GUARD_QUESTION_ID] && guard) {
		const p = guard.probabilities.block ?? (guard.choice === "block" ? 1 : 0);
		if (p > JEV_BLOCK_THRESHOLD) {
			return {
				block: true,
				reason:
					`Jev tool guard blocked this call: it judged the call does not fit the current lesson (block ${round2(p)}). ` +
					"Reconsider what the lesson needs right now and continue.",
			};
		}
	}
	const quiz = request.quiz;
	if (!quiz) return { block: false };
	let jevCorrect: string[];
	if (quiz.multiSelect) {
		const picks: string[] = [];
		for (const [i, option] of quiz.options.entries()) {
			const a = answers[quizOptionQuestionId(i)];
			if (a?.type !== "noul") return { block: false };
			if (a.noul > 0.5) picks.push(option.value);
		}
		jevCorrect = picks;
	} else {
		const key = choiceOf(answers, QUIZ_KEY_QUESTION_ID);
		if (!key) return { block: false };
		jevCorrect = [key.choice];
	}
	const same = jevCorrect.length === quiz.correct.length && jevCorrect.every((v) => quiz.correct.includes(v));
	if (same) return { block: false };
	return {
		block: true,
		reason:
			`Jev answer-key check blocked this quiz before the learner saw it: Jev thinks the correct answer is ` +
			`${quoteOptions(jevCorrect, quiz.options)}, but correctAnswer is ${quoteOptions(quiz.correct, quiz.options)}. ` +
			"Re-check the question and options, then pose the quiz again with a correct answer key.",
	};
}

// ─── understanding hint ─────────────────────────────────────────────────────

export const UNDERSTANDING_QUESTION_ID = "understanding";
export const UNDERSTANDING_LEVELS = ["understood", "partial", "misconception"] as const;
export type UnderstandingLevel = (typeof UNDERSTANDING_LEVELS)[number];

/** Jev's read, stored on the answer's details (`jev`). */
export interface JevUnderstanding {
	level: UnderstandingLevel;
	probability: number;
	probabilities: Record<UnderstandingLevel, number>;
}

export interface UnderstandingInput {
	/** The question or problem the learner answered. */
	question: string;
	/** The committed correct answer / model solution. */
	reference: string;
	/** What the learner wrote. */
	answer: string;
	/** The learner's separate reasoning, when there is one. */
	thinking?: string;
}

export function understandingRequest(input: UnderstandingInput): { state: unknown; questions: Record<string, JevQuestion> } {
	return {
		state: {
			question: clip(input.question, 4_000),
			referenceAnswer: clip(input.reference, 4_000),
			learnerAnswer: clip(input.answer, 4_000),
			...(input.thinking ? { learnerThinking: clip(input.thinking, 4_000) } : {}),
		},
		questions: {
			[UNDERSTANDING_QUESTION_ID]: {
				type: "choice",
				instructions:
					"Compared with referenceAnswer, how well does learnerAnswer show the learner understands the answer to question?",
				criteria: {
					understood: "Captures the key idea of the reference answer, reasoning included.",
					partial: "Gets part of the key idea, or is right but vague or missing the reasoning.",
					misconception: "Rests on a wrong idea, or contradicts the reference answer.",
				},
			},
		},
	};
}

export function understandingOf(answers: Record<string, JevAnswer>): JevUnderstanding | null {
	const a = choiceOf(answers, UNDERSTANDING_QUESTION_ID);
	if (!a || !(UNDERSTANDING_LEVELS as readonly string[]).includes(a.choice)) return null;
	const probabilities = Object.fromEntries(
		UNDERSTANDING_LEVELS.map((level) => [level, round2(a.probabilities[level] ?? 0)]),
	) as Record<UnderstandingLevel, number>;
	const level = a.choice as UnderstandingLevel;
	return { level, probability: probabilities[level], probabilities };
}

/** The model-facing hint text (the learner never sees it). */
export function understandingHint(u: JevUnderstanding): string {
	return `${u.level} (${u.probability}) — an automated hint from Jev; you still grade`;
}
