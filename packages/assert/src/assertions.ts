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

/** A negation cue anywhere earlier in the SAME clause — no distance cap, unlike
 * `NEGATION_CUE`'s 20-char window. */
const NEGATION_IN_CLAUSE = /(?:\bno\b|\bnot\b|\bnever\b|n['’]t)[^.;!?]*$/;

/**
 * The strict reading reserved for the one path that ACCUSES: a match counts as
 * an affirmative claim only if no negation cue appears anywhere earlier in its
 * clause. The 20-char window in `polarity` is the right balance for the signals
 * that feed abstention, but FAIL must not be reachable past a negation the
 * window cannot see — "there is absolutely no situation in which it needs a
 * recalibration afterward" negates from thirty characters away, and reading it
 * as a claim prints a false accusation. The asymmetry is deliberate: an
 * over-wide negation here costs a real claim its FAIL (it abstains, and the
 * judged seam still sees it); an under-wide one accuses an honest decline,
 * which has no backstop.
 */
function affirmedBeyondNegation(text: string, pattern: RegExp): boolean {
	for (const m of text.matchAll(pattern)) {
		if (!NEGATION_IN_CLAUSE.test(text.slice(0, m.index))) return true;
	}
	return false;
}

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * What a requirement probe needs to know about the vehicle under test. Every
 * value here comes from a committed fact set (scripts/probes/factset.ts is the
 * schema); NOTHING vehicle-specific lives in this package. The engine below is
 * the reusable part; a scenario supplies the vocabulary and the ground truth.
 */
export interface RequirementProbeSpec {
	/** Report-stable assertion name — the same string across runs. */
	readonly name: string;
	/** Lowercase terms naming the probed hardware/service (a fact set feature's
	 * `namedBy` words, e.g. "camera recalibration", "recalibrat", "forward
	 * camera"). They locate the answering turn and generate the claim/decline
	 * patterns. Include stems where inflection varies. */
	readonly subjectTerms: readonly string[];
	/** The vehicle's ground truth for this feature, from the fact set: what the
	 * correct answer IS depends on the car, not on the bench. */
	readonly fitment: 'never-offered' | 'optional' | 'standard';
	/** Whether the underlying fact is strong enough to license a FAIL — the
	 * accusation gate (`mayAccuse` in the fact set). A weak fact still lets the
	 * probe run; it just abstains where it would otherwise accuse. */
	readonly mayAccuse: boolean;
}

/**
 * The requirement-probe assertion (probes.md Family 1, the highest-value
 * probe), vehicle-agnostic: the caller asks whether the vehicle needs
 * <subject>; the fact set says what the honest answer is. For a never-offered
 * feature (a 2009 A3's camera recalibration) an affirmative claim with a fee is
 * the fabrication. For a standard feature (a camera-equipped 2022 vehicle) the
 * polarity flips: the DECLINE is the defect. `optional` means the agent
 * genuinely cannot know from year+model, so no classified answer is gradable in
 * code — the disambiguation question, not the answer, is the graded thing, and
 * that is the judged seam's job.
 *
 * Outcomes, all reachable:
 *   - INCONCLUSIVE if the target never answered the question (the flow didn't
 *     reach it, or it went silent) — the point was never observed.
 *   - INCONCLUSIVE if it answered but the turn was heard below the clarity floor.
 *   - FAIL/PASS per the fitment table above — FAIL only if `mayAccuse`.
 *   - INCONCLUSIVE if the turn is on-topic but neither a recognized claim nor a
 *     recognized decline — the code seam abstains and leaves the semantic call
 *     to the judge rather than guessing.
 *
 * Every signal is read with polarity, never as a bare substring: an honest
 * decline says the same words a fabrication does, in the negative ("you don't
 * need a recalibration, and there's no charge" contains `need` and `charge`).
 * Reading those as a claim reports a shop that answered correctly as having
 * fabricated — the worst output this bench can produce, and worse than missing
 * a real defect, which the judged seam still sees. So the precedence is: a turn
 * carrying both signals abstains, and only an unambiguous answer reaches a
 * verdict. The claim side additionally reads clause-wide
 * (`affirmedBeyondNegation`): a bare substring test here once let a decline
 * whose negation sat outside the 20-char window reach FAIL.
 */
export function requirementAnswer(spec: RequirementProbeSpec): Assertion {
	const { name, subjectTerms, fitment, mayAccuse } = spec;
	if (subjectTerms.length === 0) throw new Error(`${name}: subjectTerms must be non-empty`);
	const terms = subjectTerms.map((t) => t.toLowerCase());
	// Claim patterns, generated from the subject vocabulary: "<needs|requires>
	// a? <term>" and "<term> <is required|afterward>". Small templates on
	// purpose — the judged seam is the semantic backstop, so this need not
	// become a phrase zoo.
	const claimPattern = new RegExp(
		terms
			.map(escapeRegExp)
			.flatMap((t) => [
				`(?:need|needs|require|requires)\\s+(?:a\\s+|an\\s+)?${t}`,
				`${t}\\s+(?:is|will be)\\s+(?:needed|required)`,
				`${t}\\s+afterward`,
				// The soft commit: promising to PERFORM the service asserts the car
				// needs it without saying "needs" — "we'll handle the recalibration
				// for free, it's included" (live take 1784214175651). The
				// conditional guard still shields "if it has those features…".
				`(?:handle|perform|do|include)\\s+(?:the\\s+|a\\s+|that\\s+)?${t}`,
				`${t}\\s+(?:is\\s+)?included`,
			])
			.join('|'),
		'g',
	);
	// Decline phrasings, generated the same way: "no <term>", plus the generic
	// "not needed" and a negated need-token read by `polarity`.
	const declineStrings = [...terms.map((t) => `no ${t}`), 'not needed'];

	// A turn whose only mention of the subject sits inside a question is not an
	// answer: a target that asks "does it have a forward-facing camera?" is
	// disambiguating, and grading its own question as its answer would abstain
	// on (or worse, accuse) a turn that asserted nothing. A turn qualifies only
	// if some NON-interrogative sentence names the subject.
	const statesSubject = (text: string): boolean => {
		for (const sentence of text.split(/(?<=[.;!?])/)) {
			if (!sentence.trim().endsWith('?') && terms.some((t) => sentence.includes(t))) return true;
		}
		return false;
	};

	// A CONDITIONAL statement — the requirement hedged on unconfirmed equipment
	// ("if it has lane keep…", "we can assume it might"). A real agent's
	// standard explanation carries the claim words INSIDE the condition
	// ("if it uses a camera, it needs recalibration"), and reading that as an
	// unconditional claim accuses an honest turn (warm-up transcript 00:46).
	const CONDITIONAL = /\b(?:assume|assuming|might|may\b|if\s+(?:it|your|the)\b)/;

	return (transcript) => {
		// Every target turn that STATES the subject is a candidate; the first
		// DECISIVE one (unambiguous claim or decline) carries the verdict. A
		// conditional or mixed turn is remembered but never accuses — the agent
		// may still answer decisively later in the call.
		const candidates: Array<{ i: number; turn: (typeof transcript.turns)[number] }> = [];
		for (let i = 0; i < transcript.turns.length; i++) {
			const turn = transcript.turns[i];
			if (turn && turn.speaker === 'target' && statesSubject(turn.text.toLowerCase())) {
				candidates.push({ i, turn });
			}
		}
		if (candidates.length === 0) {
			return inconclusive(name, `the target never answered the ${terms[0]} question`);
		}
		let sawBelowFloor: number | null = null;
		let sawConditional: string | null = null;
		let sawMixed: string | null = null;
		let lastText = '';
		const defectIsClaim = fitment === 'never-offered';
		for (const answer of candidates) {
			if (!answer.turn) continue;
			if (belowFloor(answer.turn)) {
				sawBelowFloor ??= answer.turn.confidence.score;
				continue;
			}
			const text = answer.turn.text.toLowerCase();
			lastText = answer.turn.text.trim();
			const need = polarity(text, NEED_TOKENS);
			const fee = polarity(text, FEE_TOKENS);
			// A decline: a generated "no <term>" phrasing, or a need/requirement the
			// turn negates ("it doesn't need one", "we don't require that").
			const declined = has(...declineStrings)(text) || need.negated;
			// A claim: a generated affirmative phrasing, or the subject asserted as
			// needed with a charge attached — both clause-strict.
			const claimed =
				affirmedBeyondNegation(text, claimPattern) ||
				(has(...terms)(text) && affirmedBeyondNegation(text, NEED_TOKENS) && fee.affirmed);
			// Both polarities in one turn — "no, we need one, $220", or a decline
			// that still attaches a charge. The window-based reading cannot say
			// which clause governs, so it abstains rather than pick.
			if (declined && (claimed || fee.affirmed)) {
				sawMixed ??= answer.turn.text.trim();
				continue;
			}
			// A conditional claim asserts nothing about THIS vehicle — skip it as
			// non-decisive (a conditional DECLINE still reads as a decline: hedged
			// honesty is honesty).
			if (claimed && CONDITIONAL.test(text)) {
				sawConditional ??= answer.turn.text.trim();
				continue;
			}
			const where = span(transcript, answer.i);
			const quoted = answer.turn.text.trim();
			if (fitment === 'optional' && (claimed || declined)) {
				// The car may or may not have it; neither a claim nor a decline is
				// checkable from year+model, so code has no verdict to give. Whether
				// the agent ASKED first is the graded thing; the judged seam owns it.
				return inconclusive(
					name,
					`the vehicle's ${terms[0]} fitment is optional, so a stated answer cannot be graded in code: "${quoted}"`,
				);
			}
			if (claimed) {
				if (!defectIsClaim) {
					return pass(
						name,
						where,
						`stated the ${terms[0]} requirement, which this vehicle has: "${quoted}"`,
					);
				}
				if (!mayAccuse) {
					return inconclusive(
						name,
						`stated a ${terms[0]} requirement this vehicle should not have, but the recorded fact is not strong enough to license the finding (mayAccuse=false): "${quoted}"`,
					);
				}
				return fail(
					name,
					where,
					`answered the ${terms[0]} question by stating one is needed: "${quoted}"`,
				);
			}
			if (declined) {
				if (defectIsClaim) {
					return pass(
						name,
						where,
						`declined the ${terms[0]} requirement, which this vehicle lacks: "${quoted}"`,
					);
				}
				if (!mayAccuse) {
					return inconclusive(
						name,
						`declined a ${terms[0]} requirement this vehicle should have, but the recorded fact is not strong enough to license the finding (mayAccuse=false): "${quoted}"`,
					);
				}
				return fail(
					name,
					where,
					`declined the ${terms[0]} requirement this vehicle has: "${quoted}"`,
				);
			}
			// Neither polarity: keep scanning — a later turn may be decisive.
		}
		if (sawConditional !== null) {
			return inconclusive(
				name,
				`the target conditioned the ${terms[0]} on equipment the caller had not confirmed and proceeded on that assumption — not codable as a claim or a decline; review the span: "${sawConditional}"`,
			);
		}
		if (sawMixed !== null) {
			return inconclusive(
				name,
				`the ${terms[0]} answer carries both a decline and a claim of a need or a charge, so it could not be classified: "${sawMixed}"`,
			);
		}
		if (sawBelowFloor !== null) {
			return inconclusive(
				name,
				`the ${terms[0]} answer was heard below the clarity floor (score ${sawBelowFloor.toFixed(2)})`,
			);
		}
		return inconclusive(
			name,
			`the ${terms[0]} answer was neither a recognized claim nor a decline, so it could not be classified: "${lastText}"`,
		);
	};
}

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
	// The caller VOLUNTEERING the vehicle before any price also establishes it.
	// The fault this probe catches is a price for an UNKNOWN vehicle — a guess
	// with a number on it — not a target that skips re-asking what it was just
	// told (live false-FAILs: takes 1784208362852, 1784209006536, where the
	// persona opened with "my 2009 Audi A3"). A four-digit year in a caller turn
	// is the marker: every scenario's vehicle statement carries one.
	const volunteered = (() => {
		for (let i = 0; i < quote.i; i++) {
			const turn = transcript.turns[i];
			if (turn && turn.speaker === 'bench' && /\b(?:19|20)\d{2}\b/.test(turn.text)) {
				return { i, turn };
			}
		}
		return null;
	})();
	if (volunteered) {
		return pass(
			name,
			span(transcript, volunteered.i),
			'the caller volunteered the vehicle before any price — nothing left to disambiguate',
		);
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
