/**
 * Jev decisions (core/jev.ts shapes, server/jev.ts calls): the tool guard,
 * the quiz answer-key check and the understanding hint. Jev is stubbed
 * through the jevFetch seam; these tests never touch the network. Every
 * failure path must allow — a lesson never waits on Jev.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import {
	JEV_MODEL,
	JEV_URL,
	jevToolCallRequest,
	jevToolCallVerdict,
	parseJevAnswers,
	understandingOf,
	type JevAnswer,
} from "../src/core/jev.ts";
import { parseAgentSettingsBody } from "../src/server/settings-body.ts";
import { resolveSettings } from "../src/core/settings-resolution.ts";
import type { LhMessage } from "../src/core/native-messages.ts";

const dir = mkdtempSync(path.join(tmpdir(), "lh-jev-"));
const saved = {
	data: process.env.LH_DATA_DIR,
	auth: process.env.LH_AUTH_FILE,
	openrouter: process.env.OPENROUTER_API_KEY,
};
process.env.LH_DATA_DIR = dir;
process.env.LH_AUTH_FILE = path.join(dir, "auth.json");
process.env.OPENROUTER_API_KEY = "sk-or-test-jev";

const { jevBeforeToolCall, jevFetch, withJevUnderstanding } = await import("../src/server/jev.ts");
const realFetch = jevFetch.current;

after(() => {
	jevFetch.current = realFetch;
	for (const [key, env] of [["LH_DATA_DIR", saved.data], ["LH_AUTH_FILE", saved.auth], ["OPENROUTER_API_KEY", saved.openrouter]] as const) {
		if (env === undefined) delete process.env[key];
		else process.env[key] = env;
	}
	rmSync(dir, { recursive: true, force: true });
});

const choice = (picked: string, probabilities: Record<string, number>): JevAnswer => ({
	type: "choice",
	choice: picked,
	confidence: 0.9,
	probabilities,
});

/** Script Jev's reply; records each request body. */
function stubJev(reply: (body: { questions: Record<string, unknown> }) => unknown, status = 200) {
	const calls: { url: string; init: RequestInit; body: { model: string; state: unknown; questions: Record<string, unknown> } }[] = [];
	jevFetch.current = async (url, init) => {
		const body = JSON.parse(String(init.body));
		calls.push({ url, init, body });
		return new Response(JSON.stringify(reply(body)), { status });
	};
	return calls;
}

const quizArgs = {
	question: "Which planet is closest to the sun?",
	options: [{ label: "Mercury", value: "mercury" }, { label: "Venus", value: "venus" }, { label: "Mars", value: "mars" }],
	explanation: "Mercury orbits closest.",
	correctAnswer: "mercury",
};

const hookContext = (name: string, args: unknown) => ({
	assistantMessage: {} as never,
	toolCall: { type: "toolCall", id: "call_1", name, arguments: args } as never,
	args,
	context: {
		systemPrompt: "",
		messages: [{ role: "user", content: "Teach me about the solar system", timestamp: 0 }],
		tools: [],
	} as never,
});

beforeEach(() => {
	jevFetch.current = realFetch;
});

describe("Jev request and response shapes", () => {
	it("parses choice and noul answers and drops malformed ones", () => {
		const answers = parseJevAnswers({
			answers: {
				a: { type: "choice", choice: "allow", confidence: 1, probabilities: { allow: 1, block: 0 } },
				b: { type: "noul", noul: 0.3 },
				c: { type: "choice" },
			},
		});
		assert.deepEqual(Object.keys(answers ?? {}), ["a", "b"]);
		assert.equal(parseJevAnswers({ nope: 1 }), null);
		assert.equal(parseJevAnswers("x"), null);
	});

	it("never shows Jev the quiz's answer key or explanation", () => {
		const request = jevToolCallRequest({
			phase: "teach", recent: [], toolName: "quiz", args: quizArgs, toolGuard: true, quizCheck: true,
		});
		const shown = JSON.stringify(request?.state);
		assert.ok(!shown.includes("correctAnswer"));
		assert.ok(!shown.includes("Mercury orbits closest"));
		assert.deepEqual(Object.keys(request!.questions).sort(), ["fits_lesson", "quiz_key"]);
	});

	it("asks nothing when both switches are off, or the quiz check alone meets a non-quiz tool", () => {
		assert.equal(jevToolCallRequest({ phase: "teach", recent: [], toolName: "quiz", args: quizArgs, toolGuard: false, quizCheck: false }), null);
		assert.equal(jevToolCallRequest({ phase: "teach", recent: [], toolName: "read", args: { path: "x" }, toolGuard: false, quizCheck: true }), null);
	});
});

describe("tool guard", () => {
	it("blocks when Jev puts more than half on block, allows otherwise", () => {
		const request = jevToolCallRequest({ phase: "teach", recent: [], toolName: "research", args: {}, toolGuard: true, quizCheck: false })!;
		const blocked = jevToolCallVerdict(request, { fits_lesson: choice("block", { allow: 0.2, block: 0.8 }) });
		assert.equal(blocked.block, true);
		assert.match((blocked as { reason: string }).reason, /Jev tool guard blocked/);
		assert.deepEqual(jevToolCallVerdict(request, { fits_lesson: choice("allow", { allow: 0.6, block: 0.4 }) }), { block: false });
		assert.deepEqual(jevToolCallVerdict(request, {}), { block: false }, "a missing answer allows");
	});

	it("the hook posts one OpenRouter request and returns pi's block result", async () => {
		const calls = stubJev(() => ({ answers: { fits_lesson: choice("block", { allow: 0.1, block: 0.9 }) } }));
		const hook = jevBeforeToolCall({ phase: "probe", toolGuard: true, quizCheck: false })!;
		const result = await hook(hookContext("research", { query: "cats" }));
		assert.equal(calls.length, 1);
		assert.equal(calls[0]!.url, JEV_URL);
		assert.equal(calls[0]!.body.model, JEV_MODEL);
		assert.equal((calls[0]!.init.headers as Record<string, string>).Authorization, "Bearer sk-or-test-jev");
		assert.equal(result?.block, true);
	});

	it("no hook at all when both switches are off", () => {
		assert.equal(jevBeforeToolCall({ phase: "teach", toolGuard: false, quizCheck: false }), undefined);
	});

	it("fails open on an HTTP error, a thrown fetch and a missing key", async () => {
		const hook = jevBeforeToolCall({ phase: "teach", toolGuard: true, quizCheck: true })!;
		stubJev(() => ({ error: "down" }), 503);
		assert.equal(await hook(hookContext("quiz", quizArgs)), undefined);
		jevFetch.current = async () => {
			throw new Error("network down");
		};
		assert.equal(await hook(hookContext("quiz", quizArgs)), undefined);
		delete process.env.OPENROUTER_API_KEY;
		try {
			const calls = stubJev(() => ({}));
			assert.equal(await hook(hookContext("quiz", quizArgs)), undefined);
			assert.equal(calls.length, 0, "no key → no request");
		} finally {
			process.env.OPENROUTER_API_KEY = "sk-or-test-jev";
		}
	});
});

describe("quiz answer-key check", () => {
	it("single answer: allows a matching key, blocks a mismatch naming Jev's pick", async () => {
		const hook = jevBeforeToolCall({ phase: "teach", toolGuard: false, quizCheck: true })!;
		stubJev(() => ({ answers: { quiz_key: choice("mercury", { mercury: 0.9, venus: 0.05, mars: 0.05 }) } }));
		assert.equal(await hook(hookContext("quiz", quizArgs)), undefined);
		stubJev(() => ({ answers: { quiz_key: choice("mercury", { mercury: 0.9, venus: 0.05, mars: 0.05 }) } }));
		const blocked = await hook(hookContext("quiz", { ...quizArgs, correctAnswer: "venus" }));
		assert.equal(blocked?.block, true);
		assert.match(blocked!.reason!, /Jev thinks the correct answer is "mercury" \(Mercury\), but correctAnswer is "venus" \(Venus\)/);
	});

	it("multi-select: one yes/no per option; blocks when Jev's set differs from the key", async () => {
		const multi = {
			question: "Which are gas giants?",
			options: [{ label: "Jupiter", value: "jupiter" }, { label: "Saturn", value: "saturn" }, { label: "Mars", value: "mars" }],
			multiSelect: true,
			explanation: "",
			correctAnswer: ["jupiter", "mars"],
		};
		const calls = stubJev(() => ({
			answers: {
				quiz_option_0: { type: "noul", noul: 0.95 },
				quiz_option_1: { type: "noul", noul: 0.9 },
				quiz_option_2: { type: "noul", noul: 0.05 },
			},
		}));
		const hook = jevBeforeToolCall({ phase: "teach", toolGuard: false, quizCheck: true })!;
		const blocked = await hook(hookContext("quiz", multi));
		assert.deepEqual(Object.keys(calls[0]!.body.questions), ["quiz_option_0", "quiz_option_1", "quiz_option_2"]);
		assert.equal(blocked?.block, true);
		stubJev(() => ({
			answers: {
				quiz_option_0: { type: "noul", noul: 0.95 },
				quiz_option_1: { type: "noul", noul: 0.9 },
				quiz_option_2: { type: "noul", noul: 0.05 },
			},
		}));
		assert.equal(await hook(hookContext("quiz", { ...multi, correctAnswer: ["jupiter", "saturn"] })), undefined);
	});

	it("with the guard also on, both checks ride one request", async () => {
		const calls = stubJev(() => ({
			answers: {
				fits_lesson: choice("allow", { allow: 0.9, block: 0.1 }),
				quiz_key: choice("mercury", { mercury: 1, venus: 0, mars: 0 }),
			},
		}));
		const hook = jevBeforeToolCall({ phase: "teach", toolGuard: true, quizCheck: true })!;
		assert.equal(await hook(hookContext("probe", quizArgs)), undefined);
		assert.equal(calls.length, 1);
	});
});

describe("understanding hint", () => {
	const explainCall: LhMessage = {
		id: "a1",
		role: "assistant",
		content: [{ type: "toolCall", id: "ex_1", name: "explain", arguments: { question: "Why is the sky blue?", correctAnswer: "Rayleigh scattering favors short wavelengths." } }],
	} as unknown as LhMessage;
	const explainAnswer: LhMessage = {
		id: "r1",
		role: "toolResult",
		toolCallId: "ex_1",
		toolName: "explain",
		content: [{ type: "text", text: "{}" }],
		details: { kind: "explain", questionText: "Why is the sky blue?", dontKnow: false, answers: [], text: "Blue light scatters more.", answeredAt: "2026-11-01" },
		isError: false,
		timestamp: 0,
	} as unknown as LhMessage;
	const problemCall: LhMessage = {
		id: "a2",
		role: "assistant",
		content: [{ type: "toolCall", id: "pr_1", name: "problem", arguments: { statement: "Find 2+2.", modelSolution: "4" } }],
	} as unknown as LhMessage;
	const thinking: LhMessage = {
		id: "t1",
		role: "custom",
		customType: "practice-thinking",
		content: "Your thinking:\n5",
		display: true,
		details: { problemCallId: "pr_1", text: "5" },
		timestamp: 0,
	} as unknown as LhMessage;

	it("reads the 3-level choice", () => {
		assert.deepEqual(understandingOf({ understanding: choice("partial", { understood: 0.2, partial: 0.61, misconception: 0.19 }) }), {
			level: "partial",
			probability: 0.61,
			probabilities: { understood: 0.2, partial: 0.61, misconception: 0.19 },
		});
		assert.equal(understandingOf({ understanding: choice("other", {}) }), null);
	});

	it("attaches Jev's read to an explain answer and a practice submission, for the model only", async () => {
		const calls = stubJev((body) => {
			const state = (body as unknown as { state: { learnerAnswer: string } }).state;
			return {
				answers: {
					understanding: state.learnerAnswer === "5"
						? choice("misconception", { understood: 0, partial: 0.1, misconception: 0.9 })
						: choice("understood", { understood: 0.8, partial: 0.15, misconception: 0.05 }),
				},
			};
		});
		const [answer, practice] = await withJevUnderstanding([explainCall, problemCall], [explainAnswer, thinking]);
		assert.equal(calls.length, 2);
		const answerText = (answer as { content: { text: string }[] }).content[0]!.text;
		assert.match(JSON.parse(answerText).jevUnderstanding, /^understood \(0\.8\)/);
		assert.equal((answer as { details: { jev: { level: string } } }).details.jev.level, "understood");
		assert.match((practice as { content: string }).content, /\[Jev understanding: misconception \(0\.9\)/);
		assert.equal((practice as { details: { text: string } }).details.text, "5", "the learner-facing text is unchanged");
	});

	it("leaves messages untouched when Jev fails or there is nothing to judge", async () => {
		stubJev(() => ({}), 500);
		const [answer] = await withJevUnderstanding([explainCall], [explainAnswer]);
		assert.equal(answer, explainAnswer);
		const calls = stubJev(() => ({}));
		const dontKnow = { ...explainAnswer, details: { ...(explainAnswer as { details: object }).details, dontKnow: true } } as LhMessage;
		await withJevUnderstanding([explainCall], [dontKnow]);
		assert.equal(calls.length, 0);
	});
});

describe("Jev settings", () => {
	it("all three switches default off and parse strictly", () => {
		assert.deepEqual(resolveSettings({ version: 1 }).agent.jev, { toolGuard: false, answerCheck: false, quizCheck: false });
		const on = parseAgentSettingsBody({ jev: { toolGuard: true, quizCheck: true } });
		assert.ok(on.ok);
		assert.deepEqual(on.settings.jev, { toolGuard: true, quizCheck: true });
		assert.equal(parseAgentSettingsBody({ jev: { toolGuard: "yes" } }).ok, false);
		assert.equal(parseAgentSettingsBody({ jev: { other: true } }).ok, false);
		assert.equal(parseAgentSettingsBody({ jev: true }).ok, false);
	});
});
