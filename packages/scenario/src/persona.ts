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
 */

import { canStream, type Runner } from '@callbench/judge';
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

/** The caller-side view of the exchange so far. */
export interface ExchangeTurn {
	readonly speaker: 'caller' | 'agent';
	readonly text: string;
}

export type PersonaDecision =
	| { readonly kind: 'say'; readonly text: string }
	| { readonly kind: 'done' };

const REPLY_CHAR_CAP = 300;

export function personaPrompt(
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
		'- Never say the same line twice. If the agent repeats a question, do not',
		'  restate your uncertainty — commit to your best guess (for example,',
		'  "as far as I know it doesn\'t have those") and move the call forward.',
		`- When the goal is satisfied and nothing remains to ask, reply with ONLY the single word DONE — no other words before or after it.`,
		remainingProbes > 0
			? `- Do not wrap up the call yourself yet; further questions will follow.`
			: '',
		'',
		'The call so far:',
		...exchange.map((t) => `${t.speaker === 'caller' ? 'CALLER' : 'AGENT'}: ${t.text}`),
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
	const text = raw.trim().split('\n')[0]?.trim() ?? '';
	// A runaway reply is truncated at a sentence boundary inside the cap — a
	// caller line, not an essay — and the raw stays in the record untrimmed.
	let line = text;
	if (line.length > REPLY_CHAR_CAP) {
		const cut = line.slice(0, REPLY_CHAR_CAP);
		line = cut.slice(
			0,
			Math.max(cut.lastIndexOf('.'), cut.lastIndexOf('?'), cut.lastIndexOf('!')) + 1 ||
				REPLY_CHAR_CAP,
		);
	}
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

/** The first complete clause in `text`, or null if no confirmed boundary yet.
 * A boundary is `.?!` FOLLOWED BY whitespace (or a quote) — punctuation alone
 * is not enough, because in a live stream a trailing `.` may be the middle of
 * `3.5` or `$249.99` with the next digit still in flight. The clause must also
 * contain a space (two+ words): a one-word "clause" is either an abbreviation
 * (`Mr.`) or a control token (`DONE.`), and speaking either aloud is worse
 * than waiting for the full line. The cost of the stricter rule is that a
 * single-clause reply never fires early — where early fire saves ~nothing,
 * since the clause finishing IS the reply finishing. */
export function firstClause(text: string): string | null {
	const s = text.trimStart();
	const boundary = /[.?!]+["']?(?=\s)/g;
	for (let m = boundary.exec(s); m !== null; m = boundary.exec(s)) {
		const clause = s.slice(0, m.index + m[0].length).trim();
		// A one-word candidate extends to the next boundary instead of firing —
		// or never fires, which is safe. This single rule covers abbreviations
		// (`Mr.`) AND the DONE control token: every DONE shape is one word, so
		// nothing DONE-like can ever reach TTS through here.
		if (!clause.includes(' ')) continue;
		return clause;
	}
	return null;
}

/** The DONE convention, tolerantly: the bare token optionally wrapped in
 * quotes and/or trailed by sentence punctuation. Used to keep the control
 * token out of anything spoken aloud. */
export function isDoneToken(text: string): boolean {
	return /^["']?DONE["']?[.?!]?$/.test(text.trim());
}

/** A DONE the model appended to prose ("Thanks, that's all. DONE.") — the
 * observed failure mode (take 1784211829214: the token was synthesized and
 * spoken three times). Stripped before anything reaches TTS; the remaining
 * prose is the farewell, and the turn still ends the persona's part. */
const DONE_TAIL = /\s*\bDONE\b["']?[.?!]*\s*$/;

/** Split a reply line into what may be SPOKEN and whether it ended the
 * persona's part: a bare DONE speaks nothing; prose + DONE speaks the prose
 * and ends; plain prose speaks and continues. */
export function splitDoneTail(line: string): { speak: string; done: boolean } {
	if (isDoneToken(line)) return { speak: '', done: true };
	if (DONE_TAIL.test(line)) return { speak: line.replace(DONE_TAIL, '').trim(), done: true };
	return { speak: line, done: false };
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
	const started = performance.now();
	let acc = '';
	let firstClauseMs: number | null = null;
	let firedClause: string | null = null;
	for await (const delta of runner.stream(prompt)) {
		acc += delta;
		if (firedClause === null && onFirstClause) {
			// firstClause() refuses one-word clauses (which covers every DONE
			// shape) and unconfirmed boundaries (mid-decimal dots), so a control
			// token or a number fragment can never be spoken early.
			const clause = firstClause(acc);
			if (clause) {
				firedClause = clause;
				firstClauseMs = performance.now() - started;
				onFirstClause(clause);
			}
		}
	}
	const text = acc.trim().split('\n')[0]?.trim() ?? '';
	let line = text;
	if (line.length > REPLY_CHAR_CAP) {
		const cut = line.slice(0, REPLY_CHAR_CAP);
		line = cut.slice(
			0,
			Math.max(cut.lastIndexOf('.'), cut.lastIndexOf('?'), cut.lastIndexOf('!')) + 1 ||
				REPLY_CHAR_CAP,
		);
	}
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
