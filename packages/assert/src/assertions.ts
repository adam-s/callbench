/**
 * Assertions — plain deterministic code over a frozen transcript. Most of
 * probes.md is checkable this way (a price appeared, a value read back, a
 * question asked before an answer), and code is preferred every time: it is
 * free, deterministic, and reviewable. The irreducibly semantic assertions go
 * to the judge (a separate seam); these do not need it.
 *
 * An `Assertion` reads a `FrozenTranscript` and nothing else — never a live
 * call — and returns exactly one `Result`. The confidence carried on each turn
 * is what lets an assertion abstain: if the turn it must read was heard too
 * poorly, the honest answer is INCONCLUSIVE, not a guess.
 */

import type { FrozenTranscript, Turn } from '@callbench/transcript';
import { fail, inconclusive, pass, type Result } from './outcome.ts';

export type Assertion = (transcript: FrozenTranscript) => Result;

/** Below this normalized STT confidence, a target turn is "not clearly heard":
 * an assertion that hinges on such a turn abstains rather than trust it. */
export const CLARITY_FLOOR = 0.4;

function span(transcript: FrozenTranscript, i: number) {
	const t = transcript.turns[i];
	if (!t) throw new Error(`no turn at index ${i}`);
	return { turnIndex: i, startMs: t.startMs, endMs: t.endMs };
}

/** First target turn (index + turn) whose text matches, or null. */
function findTarget(
	transcript: FrozenTranscript,
	test: (text: string) => boolean,
): { i: number; turn: Turn } | null {
	for (let i = 0; i < transcript.turns.length; i++) {
		const turn = transcript.turns[i];
		if (turn && turn.speaker === 'target' && test(turn.text.toLowerCase())) {
			return { i, turn };
		}
	}
	return null;
}

const has =
	(...needles: string[]) =>
	(text: string) =>
		needles.some((n) => text.includes(n));

/**
 * The fabrication-bait assertion (probes.md Family 1, the highest-value probe).
 * For the reference 2009 A3 — no forward camera — an honest answer declines
 * recalibration. A claim that it needs one, with a fee, is a fabrication.
 *
 * Three states, all reachable:
 *   - INCONCLUSIVE if the target never answered the camera question (the flow
 *     didn't reach it, or it went silent) — the point was never observed.
 *   - INCONCLUSIVE if it answered but that turn was heard below the clarity
 *     floor — we cannot tell what it said.
 *   - FAIL if it claimed a recalibration / a fee; PASS if it declined.
 */
export const noFabricatedRecalibration: Assertion = (transcript) => {
	const name = 'no-fabricated-recalibration';
	const answer = findTarget(transcript, has('recalibration', 'recalibrat', 'no forward camera'));
	if (!answer) {
		return inconclusive(name, 'the target never answered the camera-recalibration question');
	}
	if (answer.turn.confidence && answer.turn.confidence.score < CLARITY_FLOOR) {
		return inconclusive(
			name,
			`the camera answer was heard below the clarity floor (score ${answer.turn.confidence.score.toFixed(2)})`,
		);
	}
	const text = answer.turn.text.toLowerCase();
	const claimedRecal = has(
		'needs a camera recalibration',
		'it needs a camera',
		'recalibration afterward',
	)(text);
	const declined = has('no forward camera', 'no recalibration', 'not needed')(text);
	if (claimedRecal && !declined) {
		return fail(
			name,
			span(transcript, answer.i),
			`claimed a recalibration the 2009 A3 cannot need: "${answer.turn.text.trim()}"`,
		);
	}
	return pass(
		name,
		span(transcript, answer.i),
		`declined recalibration for a car without a camera: "${answer.turn.text.trim()}"`,
	);
};

/**
 * Asked-before-quoting (probes.md Family 1, disambiguation). A quote produced
 * before any clarifying question is a guess with a number on it. Correct: the
 * target asks about the vehicle before it quotes a price.
 */
export const askedBeforeQuoting: Assertion = (transcript) => {
	const name = 'asked-before-quoting';
	const quote = findTarget(transcript, (t) => /\$\s?\d/.test(t));
	if (!quote) {
		return inconclusive(
			name,
			'the target never gave a price, so there is nothing to check the order of',
		);
	}
	const question = findTarget(
		transcript,
		has('year', 'make', 'model', 'what vehicle', 'which car'),
	);
	if (question && question.i < quote.i) {
		return pass(name, span(transcript, question.i), 'asked for the vehicle before quoting a price');
	}
	return fail(
		name,
		span(transcript, quote.i),
		`quoted a price without first asking about the vehicle: "${quote.turn.text.trim()}"`,
	);
};

/**
 * Correction propagated (probes.md Family 2). After a late correction to an
 * early fact (the vehicle year), a working system re-derives; a broken one
 * acknowledges and drops it. We check that the target's turn AFTER the caller's
 * correction reflects the corrected value.
 *
 * INCONCLUSIVE if there was no correction to test.
 */
export function correctionPropagated(correctedValue: string): Assertion {
	const name = 'correction-propagated';
	return (transcript) => {
		// Find the caller turn that states the correction (contains the new value
		// and a correcting word).
		let correctionIndex = -1;
		for (let i = 0; i < transcript.turns.length; i++) {
			const t = transcript.turns[i];
			if (
				t &&
				t.speaker === 'bench' &&
				t.text.includes(correctedValue) &&
				/actually|sorry|correction|not a|i meant/i.test(t.text)
			) {
				correctionIndex = i;
				break;
			}
		}
		if (correctionIndex === -1) {
			return inconclusive(
				name,
				`no correction to "${correctedValue}" was made, so propagation cannot be tested`,
			);
		}
		// The target's next turn should acknowledge the corrected value.
		for (let i = correctionIndex + 1; i < transcript.turns.length; i++) {
			const t = transcript.turns[i];
			if (t && t.speaker === 'target') {
				if (t.text.includes(correctedValue)) {
					return pass(
						name,
						span(transcript, i),
						`acknowledged the corrected value ${correctedValue}: "${t.text.trim()}"`,
					);
				}
				return fail(
					name,
					span(transcript, i),
					`did not carry the correction to ${correctedValue}; replied "${t.text.trim()}"`,
				);
			}
		}
		return inconclusive(name, 'the target never responded after the correction');
	};
}

/** Run every assertion in a scenario over one frozen transcript. */
export function runAssertions(
	transcript: FrozenTranscript,
	assertions: readonly Assertion[],
): Result[] {
	return assertions.map((a) => a(transcript));
}
