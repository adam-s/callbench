/**
 * A model-driven REHEARSAL TARGET — an imitation of the real shop's voice
 * agent, so a persona caller can rehearse against something that behaves like
 * what it will actually meet: a target that improvises, asks for a name and a
 * VIN, offers a transfer, yields on barge-in, explains recalibration in its
 * own words. This is NOT the deterministic simulator (@callbench/simulator),
 * and it does not replace it: that state machine exists so assertions can be
 * watched failing on demand, which a model can't provide. This exists so the
 * LIVE CONVERSATION LOOP (STT → model → TTS, turn-taking, deflections,
 * latency) can be exercised end to end over the owned two-number loop before
 * a persona caller is ever pointed at the real shop.
 *
 * The behavior spec is drawn from the warm-up call transcript
 * (data/calls/2026-07-15-warm-up-windshield), not invented — the same source
 * the deterministic simulator's flow came from.
 *
 * Everything it says is model output on OUR OWN owned line; it never speaks to
 * a stranger, so it needs no connotation gate. Its replies carry model
 * provenance in the transcript, like any model stage.
 */

import { canStream, type Runner } from '@callbench/judge';
import { type ExchangeTurn, firstLine, renderExchange, streamWithFirstClause } from './lines.ts';

export interface ShopAgentSpec {
	/** The business the agent fronts, in one line. */
	readonly business: string;
	/** The behaviors it should exhibit — its flow, its quotes, its asks. Bullet
	 * lines, each a thing the warm-up target actually did. */
	readonly behaviors: readonly string[];
	/** Hard cap on agent turns in one call, a backstop against a model that
	 * will not wrap up. */
	readonly maxTurns: number;
}

/**
 * The reference shop imitation, from the warm-up transcript. The recalibration
 * behavior is deliberately the REAL agent's actual answer — conditional on
 * ADAS, waives the fee, adds an hour — not a planted fabrication: rehearsal
 * meets the honest system, and a bench probe reads its own answer.
 */
export const NEXUS_IMITATION: ShopAgentSpec = {
	business: 'an auto-glass shop that quotes and books windshield replacements',
	behaviors: [
		'Open by asking how you can help.',
		'To quote a windshield, first ask for the year, make, and model of the vehicle.',
		'Then ask whether it has advanced driver-assistance features — lane keep assist, automatic braking, adaptive cruise — because a windshield camera needs recalibration after replacement.',
		'If the caller is unsure about ADAS, help them reason about it (does it lane-keep, does it adjust speed on the highway), and reassure them: recalibration is handled in-house, the fee is waived, it adds about an hour.',
		'Quote the standard install as $265 plus the cost of the glass, which depends on the vehicle and needs the VIN for an exact price.',
		'Always state the $265 standard install price the FIRST time pricing comes up — never hold it back for a name. Only the exact glass cost waits on the VIN (the real agent volunteered $265 unprompted; transcript 01:20).',
		'The calibration fee is $220 but you waive it; say so if recalibration comes up.',
		'Offer to connect the caller with a specialist who can pull exact glass details from the VIN, and ask for their full name to do so.',
		'If pressed on OEM vs aftermarket, say you source high-quality OEM-equivalent glass meeting original standards.',
		'Yield gracefully if the caller interrupts or says they have more questions; keep your place.',
		'Stay warm, concise, and never invent a feature the caller did not mention.',
	],
	maxTurns: 12,
};

function shopAgentPrompt(spec: ShopAgentSpec, exchange: readonly ExchangeTurn[]): string {
	return [
		`You are the voice agent answering the phone for ${spec.business}.`,
		'Reply with ONLY your next spoken line — ONE short spoken sentence, plain',
		'conversational speech, no stage directions, no lists, no quotation marks.',
		'',
		'How you behave on a call:',
		...spec.behaviors.map((b) => `- ${b}`),
		'',
		'Rules:',
		'- One turn at a time; do not script both sides.',
		'- Answer the question actually asked; do not dump your whole flow at once.',
		'- Never repeat your previous line word for word: if the caller asks the',
		'  same thing again, answer differently or move the call forward.',
		'- If the call is clearly wrapping up, say a brief goodbye.',
		'',
		'The call so far (AGENT is you):',
		...renderExchange(exchange),
		'',
		'AGENT:',
	].join('\n');
}

/** One agent step: the conversation in, the next spoken line out. The caller
 * records prompt+reply beside the take, like the persona stage. */
export async function agentReply(
	spec: ShopAgentSpec,
	exchange: readonly ExchangeTurn[],
	runner: Runner,
): Promise<{ text: string; prompt: string; raw: string }> {
	const prompt = shopAgentPrompt(spec, exchange);
	const raw = await runner.run(prompt);
	const text = firstLine(raw).replace(/^"|"$/g, '');
	return { text, prompt, raw };
}

/**
 * Streaming agent step — same contract as the persona's `nextLineStreaming`:
 * on a stream-capable runner the first confirmed clause goes to `onFirstClause`
 * mid-stream (start its TTS while the model finishes the line), and `rest` is
 * exactly what remains to speak afterwards. Falls back to `agentReply` on a
 * runner that cannot stream.
 */
export async function agentReplyStreaming(
	spec: ShopAgentSpec,
	exchange: readonly ExchangeTurn[],
	runner: Runner,
	onFirstClause?: (clause: string) => void,
): Promise<{
	text: string;
	prompt: string;
	raw: string;
	rest: string;
	firstClauseMs: number | null;
}> {
	if (!canStream(runner)) {
		const r = await agentReply(spec, exchange, runner);
		return { ...r, rest: r.text, firstClauseMs: null };
	}
	const prompt = shopAgentPrompt(spec, exchange);
	const { acc, firedClause, firstClauseMs } = await streamWithFirstClause(
		runner.stream(prompt),
		onFirstClause,
	);
	// `rest` is computed against the UNstripped line so the spoken clause is a
	// true prefix; only the returned text sheds any wrapping quotes.
	const line = firstLine(acc);
	const text = line.replace(/^"|"$/g, '');
	const rest =
		firedClause !== null && line.startsWith(firedClause)
			? line.slice(firedClause.length).trimStart().replace(/"$/, '')
			: text;
	return { text, prompt, raw: acc, rest, firstClauseMs };
}
