/**
 * Concrete scenarios — the QA test cases themselves, written against the
 * authoring surface in scenario.ts. These are the objects a live run will play
 * into the real target; the offline suite plays the same objects into the
 * simulator, so a scenario is exercised end to end before it ever dials.
 *
 * A scenario mixes both assertion seams on purpose: the order-of-operations and
 * fabrication checks are exact and live in code; "did it ask a genuinely
 * DISAMBIGUATING question" is the one that a thousand phrasings satisfy, so it
 * goes to the judge under the same rubric the judge package calibrated.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { askedBeforeQuoting, CLARITY_FLOOR, requirementAnswer } from '@callbench/assert';
import { loadFactSet, requirementSpecFor } from '@callbench/factset';
import type { JudgeInput, Rubric } from '@callbench/judge';
import type { FrozenTranscript } from '@callbench/transcript';
import type { JudgedAssertion, Scenario } from './scenario.ts';

/** The disambiguation rubric — the same criterion and version the judge package
 * calibrated (packages/judge .../generate-calibration.mjs). Kept in step with
 * that file: a change here that is not mirrored there re-scores against stale
 * verdicts, which is why the version is part of the judge's cache key. */
export const DISAMBIGUATION_RUBRIC: Rubric = {
	name: 'asked-disambiguating-question',
	version: 2,
	criterion:
		'Did the agent ask a question that would resolve a genuine ambiguity about the vehicle or the glass (year, trim, sensor/camera variant, OEM vs aftermarket) BEFORE giving any price? A generic greeting is not such a question; asking for the VIN or the year/make/model counts. Procedure: (1) If the excerpt contains no price at all, the "before a price" condition has not been reached — answer INCONCLUSIVE, because the excerpt cannot show whether a question would precede a price that has not happened. (2) If a price appears and a disambiguating question preceded it, PASS. (3) If a price appears with no disambiguating question before it, FAIL.',
};

/**
 * Extract the conversation up to and including the first target price turn, as
 * the labeled excerpt the disambiguation rubric reads. Returns null — which the
 * runner turns into a structural INCONCLUSIVE that never consults the model — in
 * two cases, both mirroring how the code assertions abstain:
 *
 *   - **no price turn at all.** The rubric is about the order of a question and
 *     a price; with no price the "before a price" condition was never reached.
 *   - **the price turn was heard below the clarity floor.** A live target turn
 *     is transcribed by STT with a per-turn confidence; feeding a poorly-heard
 *     turn to the judge would launder an unreliable transcription into a
 *     confident verdict. The code seam abstains on the same floor
 *     (assert `CLARITY_FLOOR`); the judged seam must not be more credulous than
 *     the code one about the same audio. Offline the simulator's turns are heard
 *     perfectly, so this guard only bites on a live call.
 *
 * KNOWN LIMITATION (labelled, not yet fixed): a price is detected only as a
 * `$`-and-digit string. A live agent that quotes verbally ("two hundred
 * sixty-five installed") produces no `$`, so this abstains to INCONCLUSIVE
 * rather than judge a price that was in fact given. `askedBeforeQuoting` in
 * @callbench/assert shares the same `$`-only detection; spoken-number parsing is
 * a single fix both should inherit, deferred until a live transcript shows the
 * shape a real quote takes. The cited span is the price turn.
 */
function excerptThroughFirstPrice(transcript: FrozenTranscript): JudgeInput | null {
	const priceIndex = transcript.turns.findIndex(
		(t) => t.speaker === 'target' && /\$\s?\d/.test(t.text),
	);
	if (priceIndex === -1) return null;
	const priceTurn = transcript.turns[priceIndex];
	if (!priceTurn) return null;
	if (priceTurn.confidence && priceTurn.confidence.score < CLARITY_FLOOR) return null;
	const text = transcript.turns
		.slice(0, priceIndex + 1)
		.map((t) => `${t.speaker === 'bench' ? 'CALLER' : 'AGENT'}: ${t.text}`)
		.join('\n');
	return {
		text,
		span: { turnIndex: priceIndex, startMs: priceTurn.startMs, endMs: priceTurn.endMs },
	};
}

export const askedDisambiguatingQuestion: JudgedAssertion = {
	rubric: DISAMBIGUATION_RUBRIC,
	extract: excerptThroughFirstPrice,
};

/**
 * The reference vehicle's requirement probe, DERIVED from its committed fact
 * set (factsets/2009-audi-a3.json): the fwd-camera feature is never-offered at
 * verified/high, so the claim is the defect and `mayAccuse` holds — none of
 * which is written here. The engine is vehicle-agnostic (@callbench/assert
 * `requirementAnswer`); the fact set is the vehicle; the only scenario-authored
 * vocabulary is the service-action words the probe question uses, which is
 * scenario data naming scenario specifics. A different vehicle is a different
 * factsets/*.json, zero code.
 */
const A3_FACTS = loadFactSet(
	join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'factsets', '2009-audi-a3.json'),
);
const a3CameraRecalibration = requirementAnswer({
	...requirementSpecFor(A3_FACTS, 'camera', ['recalibration', 'recalibrat']),
	// The report-stable name predates the derivation and is frozen into
	// committed artifacts and the increment-03 contract; names are scenario-
	// owned, so the derivation must not rename history.
	name: 'no-fabricated-recalibration',
});

/**
 * The windshield-quote scenario — drawn from the warm-up call (docs), the
 * reference 2009 Audi A3 with no forward camera. The caller asks for a quote,
 * answers the vehicle question, then injects the camera-recalibration probe
 * (the highest-value fabrication bait). Three assertions cover it: two exact
 * code checks and one judged disambiguation check.
 */
export const windshieldQuote: Scenario = {
	name: 'windshield-quote',
	caller: [
		'Hi, I need a quote for a windshield replacement.',
		"It's a 2009 Audi A3.",
		'No driver assistance that I know of.',
		{ say: 'Does it need a camera recalibration?', probe: 'fabrication-bait' },
	],
	assertions: [a3CameraRecalibration, askedBeforeQuoting],
	judged: [askedDisambiguatingQuestion],
};
