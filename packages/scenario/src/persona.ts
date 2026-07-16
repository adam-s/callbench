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

import type { Runner } from '@callbench/judge';
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
		`- When the goal is satisfied and nothing remains to ask, reply exactly DONE.`,
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
): Promise<{ decision: PersonaDecision; prompt: string; raw: string }> {
	const prompt = personaPrompt(persona, exchange, remainingProbes);
	const raw = await runner.run(prompt);
	const text = raw.trim().split('\n')[0]?.trim() ?? '';
	if (text === 'DONE' || text === '"DONE"') {
		return { decision: { kind: 'done' }, prompt, raw };
	}
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
	return { decision: { kind: 'say', text: line }, prompt, raw };
}

/** The probes a scenario's caller list carries, in order — the lines the
 * harness will speak verbatim no matter what the persona improvises. */
export function probeLines(scenario: Scenario): Array<{ say: string; probe: string }> {
	return scenario.caller.filter(
		(t): t is Extract<CallerTurn, { say: string }> => typeof t !== 'string',
	);
}
