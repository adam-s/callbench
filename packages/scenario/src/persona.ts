/**
 * The hybrid caller persona (Increment 6): a model carries the CONVERSATION,
 * the harness carries the TEST. The split is the whole design:
 *
 *   - The model gets the goal, the caller's background facts, and the
 *     conversation so far, and returns only the next spoken line — how a real
 *     caller would react to whatever the far end actually said, which no
 *     script can pre-write for a target we don't control.
 *   - The PROBES stay out of its hands. A probe line is spoken verbatim by
 *     the harness at its moment, whatever the model would have preferred: an
 *     improvising persona that glides past a probe produces a call that looks
 *     successful and tests nothing (plan.md, Increment 6). Enforcement is
 *     code, not a prompt request.
 *
 * Every persona line is model judgment, and it is recorded as such: the turn's
 * provider carries the model id, and the caller of `nextLine` is expected to
 * persist each prompt+reply beside the take, so the improvisation is
 * reviewable after the fact (AGENTS.md: model judgment lives in reviewable
 * artifacts; here the judgment IS the product, an isolated, named stage).
 *
 * Bounded by construction: a hard cap on persona turns per call, a per-reply
 * text length cap, and a DONE convention. Runs against the simulator first —
 * an improvising persona is cheap to catch there (plan.md).
 *
 * Line handling shared with the rehearsal shop agent (first-clause streaming,
 * sentence capping, the DONE token) lives in ./lines.ts.
 */

import { canStream, type Runner } from '@callbench/judge';
import {
	capAtSentence,
	type ExchangeTurn,
	firstLine,
	renderExchange,
	splitDoneTail,
	streamWithFirstClause,
} from './lines.ts';
import type { CallerTurn, Scenario } from './scenario.ts';

export interface Persona {
	/** What the caller is trying to get done, in one or two sentences. */
	readonly goal: string;
	/** What the caller knows and may naturally volunteer — the vehicle, the
	 * situation. The persona must not invent facts beyond these. */
	readonly background: readonly string[];
	/** Optional register note ("brief, casual, a little hurried"). */
	readonly style?: string;
	/** Hard cap on model-authored turns in one call. The probes are extra. */
	readonly maxFreeTurns: number;
}

export type PersonaDecision =
	| { readonly kind: 'say'; readonly text: string }
	| { readonly kind: 'done' };

const REPLY_CHAR_CAP = 300;

function personaPrompt(
	persona: Persona,
	exchange: readonly ExchangeTurn[],
	remainingProbes: number,
): string {
	return [
		'You are role-playing an ordinary caller on a phone call. Reply with ONLY',
		"the caller's next spoken line — one utterance, plain conversational",
		'speech, no stage directions, no quotation marks, no lists.',
		'',
		`Goal: ${persona.goal}`,
		'You know, and may naturally mention, only these facts:',
		...persona.background.map((f) => `- ${f}`),
		persona.style ? `Speaking style: ${persona.style}` : '',
		'',
		'Rules:',
		'- Never invent facts beyond the list (no other vehicle details, no name,',
		'  no phone number, no address; deflect naturally if asked).',
		'- Keep each line to ONE short sentence; a real caller waits for the agent and does not monologue.',
		'- If the agent asked a question, answer it from the facts (or deflect).',
		'- Never repeat a question the agent has already deflected: if they would',
		'  not answer it twice, accept that and move to the next thing you want.',
		"- You are ONLY the caller. Never speak the agent's side, and never answer",
		'  your own question — if the agent has not answered yet, wait for them or',
		'  ask it a different way.',
		'- Never say the same line twice. If the agent repeats a question, do not',
		'  restate your uncertainty — commit to your best guess (for example,',
		'  "as far as I know it doesn\'t have those") and move the call forward.',
		`- When the goal is satisfied and nothing remains to ask, reply with ONLY the single word DONE — no other words before or after it.`,
		remainingProbes > 0
			? `- Do not wrap up the call yourself yet; further questions will follow.`
			: '',
		'',
		'The call so far:',
		...renderExchange(exchange),
		'',
		'CALLER:',
	]
		.filter((l) => l !== '')
		.join('\n');
}

/** One persona step: model in, next line (or DONE) out. Pure over its inputs
 * apart from the runner call; the caller records prompt+reply for review. */
export async function nextLine(
	persona: Persona,
	exchange: readonly ExchangeTurn[],
	remainingProbes: number,
	runner: Runner,
): Promise<{ decision: PersonaDecision; prompt: string; raw: string; alsoDone: boolean }> {
	const prompt = personaPrompt(persona, exchange, remainingProbes);
	const raw = await runner.run(prompt);
	const line = capAtSentence(firstLine(raw), REPLY_CHAR_CAP);
	const { speak, done } = splitDoneTail(line);
	if (speak.length === 0) {
		return {
			decision: done ? { kind: 'done' } : { kind: 'say', text: line },
			prompt,
			raw,
			alsoDone: false,
		};
	}
	return { decision: { kind: 'say', text: speak }, prompt, raw, alsoDone: done };
}

/**
 * Streaming persona step — the latency fix. On a stream-capable runner it yields
 * the FIRST CLAUSE the instant the model has produced one (via `onFirstClause`),
 * so the caller can start TTS before the reply is finished (the measured 4.7s
 * LLM block otherwise blocks the whole turn). Falls back to `nextLine` on a
 * runner that cannot stream. Returns the same shape as `nextLine` once the reply
 * is complete; the persona wants one short sentence, so the first clause is
 * usually the whole line and the callback fires ~a clause early.
 */
export async function nextLineStreaming(
	persona: Persona,
	exchange: readonly ExchangeTurn[],
	remainingProbes: number,
	runner: Runner,
	onFirstClause?: (clause: string) => void,
): Promise<{
	decision: PersonaDecision;
	prompt: string;
	raw: string;
	firstClauseMs: number | null;
	/** Exactly what remains to speak after the `onFirstClause` clause — the
	 * caller speaks clause + rest, never clause + full text. Equals
	 * `decision.text` when the callback never fired. */
	rest: string;
	/** True when the reply carried a trailing DONE after prose: speak the
	 * text, then treat the persona's part as ended. */
	alsoDone: boolean;
}> {
	if (!canStream(runner)) {
		const r = await nextLine(persona, exchange, remainingProbes, runner);
		return { ...r, firstClauseMs: null, rest: r.decision.kind === 'say' ? r.decision.text : '' };
	}
	const prompt = personaPrompt(persona, exchange, remainingProbes);
	const { acc, firedClause, firstClauseMs } = await streamWithFirstClause(
		runner.stream(prompt),
		onFirstClause,
	);
	const line = capAtSentence(firstLine(acc), REPLY_CHAR_CAP);
	// The DONE tail never reaches TTS — bare DONE speaks nothing; prose+DONE
	// speaks the prose and ends the persona's part. A fired clause cannot be
	// DONE-shaped (firstClause refuses one-word clauses).
	const { speak, done } = splitDoneTail(line);
	if (speak.length === 0) {
		return {
			decision: done ? { kind: 'done' } : { kind: 'say', text: line },
			prompt,
			raw: acc,
			firstClauseMs,
			rest: '',
			alsoDone: false,
		};
	}
	// What was already spoken via the callback must not be spoken again. The
	// clause is a prefix of the (possibly truncated) line in every normal run;
	// if truncation or multi-line trimming broke that, fall back to the full
	// line and accept a repeat over a dropped fragment.
	const rest =
		firedClause !== null && speak.startsWith(firedClause)
			? speak.slice(firedClause.length).trimStart()
			: speak;
	return {
		decision: { kind: 'say', text: speak },
		prompt,
		raw: acc,
		firstClauseMs,
		rest,
		alsoDone: done,
	};
}

/** The probes a scenario's caller list carries, in order — the lines the
 * harness will speak verbatim no matter what the persona improvises. */
export function probeLines(scenario: Scenario): Array<{ say: string; probe: string }> {
	return scenario.caller.filter(
		(t): t is Extract<CallerTurn, { say: string }> => typeof t !== 'string',
	);
}
