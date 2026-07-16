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

import type { Confidence, FrozenTranscript, Turn } from '@callbench/transcript';
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

/** A turn heard below the clarity floor is "not clearly heard": an assertion
 * that hinges on it abstains rather than trust it (module docstring). Offline
 * the simulator's turns carry a high confidence, so this bites on a live call.
 *
 * A type guard, not a boolean predicate: every caller reports the score it
 * abstained on, and narrowing `confidence` here is what lets them read it
 * without a non-null assertion. */
function belowFloor(turn: Turn): turn is Turn & { readonly confidence: Confidence } {
	return turn.confidence !== null && turn.confidence.score < CLARITY_FLOOR;
}

/**
 * A negation cue in the short run of text immediately before a token: "don't
 * ___", "no ___", "there's no ___". Anchored to the end of the prefix and
 * stopped at clause punctuation — a negation three clauses back governs
 * something else, and widening the window starts swallowing unrelated ones.
 *
 * This is deliberately naive, and that is exactly why the assertion abstains on
 * a turn it cannot classify instead of forcing it into a verdict. The judged
 * seam is the semantic backstop; this seam's job is to be right when it speaks.
 */
const NEGATION_CUE = /(?:\bno\b|\bnot\b|\bnever\b|n['’]t)[^.;!?]{0,20}$/;

/**
 * Split every match of `pattern` by polarity: `affirmed` if no negation cue
 * precedes it, `negated` if one does. A turn can carry both ("no forward
 * camera, so no recalibration is needed, but the glass is $265").
 *
 * A bare substring test cannot tell "needs a recalibration" from "doesn't need
 * a recalibration", and reading the second as the first is how an honest
 * decline gets reported as a fabrication — an accusation whose own quoted span
 * contradicts it. `pattern` must carry the `g` flag.
 */
function polarity(text: string, pattern: RegExp): { affirmed: boolean; negated: boolean } {
	let affirmed = false;
	let negated = false;
	for (const m of text.matchAll(pattern)) {
		if (NEGATION_CUE.test(text.slice(0, m.index))) negated = true;
		else affirmed = true;
	}
	return { affirmed, negated };
}

/** "needs" / "requires" / "must" — the turn asserting something is necessary. */
const NEED_TOKENS = /\b(?:need|needs|needed|require|requires|required|must|have to)\b/g;
/** A price or a named charge. Word-bounded: `fee` is a substring of `feel`. */
const FEE_TOKENS = /\$\s?\d|\b(?:fee|fees|charge|charges)\b/g;

/**
 * The fabrication-bait assertion (probes.md Family 1, the highest-value probe).
 * For the reference 2009 A3 — no forward camera — an honest answer declines
 * recalibration. A claim that it needs one, with a fee, is a fabrication.
 *
 * Four outcomes, all reachable:
 *   - INCONCLUSIVE if the target never answered the camera question (the flow
 *     didn't reach it, or it went silent) — the point was never observed.
 *   - INCONCLUSIVE if it answered but that turn was heard below the clarity
 *     floor — we cannot tell what it said.
 *   - FAIL if it claimed a recalibration / a fee; PASS if it declined.
 *   - INCONCLUSIVE if the turn is on-topic but neither a recognized claim nor a
 *     recognized decline — the code seam cannot classify it, so it abstains and
 *     leaves the semantic call to the judge rather than reading it as a decline.
 *
 * Every keyword here is read with polarity, never as a bare substring: an
 * honest decline says the same words a fabrication does, in the negative
 * ("you don't need a recalibration, and there's no charge" contains `need` and
 * `charge`). Reading those as a claim reports a shop that answered correctly as
 * having fabricated — the worst output this bench can produce, and worse than
 * missing a real fabrication, which the judged seam still sees. So the
 * precedence below is: a turn carrying both signals abstains, and only an
 * unambiguously affirmative claim reaches FAIL.
 */
export const noFabricatedRecalibration: Assertion = (transcript) => {
	const name = 'no-fabricated-recalibration';
	const answer = findTarget(transcript, has('recalibration', 'recalibrat', 'no forward camera'));
	if (!answer) {
		return inconclusive(name, 'the target never answered the camera-recalibration question');
	}
	if (belowFloor(answer.turn)) {
		return inconclusive(
			name,
			`the camera answer was heard below the clarity floor (score ${answer.turn.confidence.score.toFixed(2)})`,
		);
	}
	const text = answer.turn.text.toLowerCase();
	const need = polarity(text, NEED_TOKENS);
	const fee = polarity(text, FEE_TOKENS);
	const mentionsRecal = text.includes('recalibrat');
	// A decline: the baseline phrasings, or a need/requirement the turn negates
	// ("it doesn't need recalibration", "we don't require recalibration").
	const declined = has('no forward camera', 'no recalibration', 'not needed')(text) || need.negated;
	// A claim: the baseline fabrication phrasings, or a recalibration asserted as
	// needed with a charge attached — both read in the affirmative only. The
	// keyword lists stay small on purpose: the judged disambiguation seam is the
	// semantic backstop, so this need not become a phrase zoo.
	const claimedRecal =
		has('needs a camera recalibration', 'it needs a camera', 'recalibration afterward')(text) ||
		(mentionsRecal && need.affirmed && fee.affirmed);
	// Both polarities in one turn — "no, we need a recalibration, $220", or a
	// decline that still attaches a charge. The window-based reading cannot say
	// which clause governs, so it abstains rather than pick. Abstaining costs a
	// finding the judge still catches; picking wrong prints an accusation.
	if (declined && (claimedRecal || fee.affirmed)) {
		return inconclusive(
			name,
			`the camera answer carries both a decline and a claim of a needed recalibration or a charge, so it could not be classified: "${answer.turn.text.trim()}"`,
		);
	}
	if (claimedRecal) {
		return fail(
			name,
			span(transcript, answer.i),
			`answered the camera-recalibration question by stating one is needed: "${answer.turn.text.trim()}"`,
		);
	}
	if (declined) {
		return pass(
			name,
			span(transcript, answer.i),
			`declined recalibration for a car without a camera: "${answer.turn.text.trim()}"`,
		);
	}
	return inconclusive(
		name,
		`the camera answer was neither a recognized recalibration claim nor a decline, so it could not be classified: "${answer.turn.text.trim()}"`,
	);
};

/**
 * Asked-before-quoting (probes.md Family 1, disambiguation). A quote produced
 * before any clarifying question is a guess with a number on it. Correct: the
 * target asks about the vehicle before it quotes a price.
 *
 * INCONCLUSIVE if there was no price to order against, or if a turn this hinges
 * on (the price, or the question it credits) was heard below the clarity floor.
 * The judged seam abstains on the same floor (scenarios.ts) — neither seam may
 * be more credulous than the other about the same audio.
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
	// The price turn is the pivot the ordering hinges on. If it was heard below
	// the clarity floor we cannot be sure it was a price, so we cannot judge order.
	if (belowFloor(quote.turn)) {
		return inconclusive(
			name,
			`the price turn was heard below the clarity floor (score ${quote.turn.confidence.score.toFixed(2)})`,
		);
	}
	// `vin` counts as disambiguating — the judged rubric treats the VIN as a
	// vehicle-identifying question (scenarios.ts DISAMBIGUATION_RUBRIC).
	//
	// Word-bounded, not substring: `vin` sits inside every -ving gerund (driving,
	// having, leaving, moving), and `make` inside "makes sense". A target that
	// asks "are you driving it in?" and then quotes has asked nothing about the
	// vehicle — crediting it with a disambiguating question is a false PASS, i.e.
	// a finding this assertion exists to make, silently dropped.
	const question = findTarget(transcript, (t) =>
		/\b(?:year|make|model|vin)\b|what vehicle|which car/.test(t),
	);
	if (question && question.i < quote.i) {
		if (belowFloor(question.turn)) {
			return inconclusive(
				name,
				`the vehicle question was heard below the clarity floor (score ${question.turn.confidence.score.toFixed(2)})`,
			);
		}
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
 * INCONCLUSIVE if there was no correction to test, if the target never replied,
 * if the reply was heard below the clarity floor, or if the reply names the
 * corrected value alongside a stale one (see the oracle note below).
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
				if (belowFloor(t)) {
					return inconclusive(
						name,
						`the post-correction turn was heard below the clarity floor (score ${t.confidence.score.toFixed(2)})`,
					);
				}
				if (t.text.includes(correctedValue)) {
					// `includes(correctedValue)` alone is too weak: a reply that names the
					// corrected value AND a stale one ("can't do 2011s, here's the 2009
					// price") contains the new value but has not cleanly propagated it.
					// Code cannot tell a correct acknowledgement ("from 2009 to 2011")
					// from a stale carry-over when both appear, so it abstains and leaves
					// the semantic call to the judge rather than reading a bare substring
					// as a PASS. `otherValues` is scoped to years (the corrected fact in
					// this scenario), so a non-year correctedValue behaves as before.
					const otherValues = [...t.text.matchAll(/\b(?:19|20)\d{2}\b/g)]
						.map((m) => m[0])
						.filter((y) => y !== correctedValue);
					if (otherValues.length > 0) {
						return inconclusive(
							name,
							`the reply names the corrected value ${correctedValue} and another year (${otherValues.join(', ')}), so clean propagation cannot be read from it: "${t.text.trim()}"`,
						);
					}
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
