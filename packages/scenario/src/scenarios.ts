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
import {
	askedBeforeQuoting,
	CLARITY_FLOOR,
	correctionPropagated,
	requirementAnswer,
} from '@callbench/assert';
import { type FactSet, loadFactSet, requirementSpecFor } from '@callbench/factset';
import type { JudgeInput, Rubric } from '@callbench/judge';
import { scriptFromFactSet } from '@callbench/simulator';
import type { FrozenTranscript } from '@callbench/transcript';
import type { JudgedAssertion, Scenario } from './scenario.ts';

/** The fixed half of the disambiguation criterion — the procedure never varies
 * by vehicle; only the domain nouns do. */
const DISAMBIGUATION_PROCEDURE =
	'A generic greeting is not such a question; asking for the VIN or the year/make/model counts. Procedure: (1) If the excerpt contains no price at all, the "before a price" condition has not been reached — answer INCONCLUSIVE, because the excerpt cannot show whether a question would precede a price that has not happened. (2) If a price appears and a disambiguating question preceded it, PASS. (3) If a price appears with no disambiguating question before it, FAIL.';

/**
 * The disambiguation rubric, derived from a fact set: the criterion's
 * procedure is fixed; the domain nouns (the service, the equipment variants
 * that genuinely change the job) come from the vehicle's data, so a
 * brake-service call is not judged through windshield examples. Version 3
 * marks the templating — the judge's cache key covers the full criterion text,
 * so no stale verdict replays for a different vehicle's wording. A rubric only
 * counts once CALIBRATED: re-run packages/judge .../generate-calibration.mjs
 * (a bounded live-model script, by hand) for each new instantiation.
 */
export function disambiguationRubricFor(fs_: FactSet): Rubric {
	const variants = fs_.features.map((f) => f.label).join(', ');
	return {
		name: 'asked-disambiguating-question',
		version: 3,
		criterion: `Did the agent ask a question that would resolve a genuine ambiguity about the vehicle or the requested service (${fs_.service}) — the year, the trim, an equipment variant that changes the job (${variants}), or the parts choice — BEFORE giving any price? ${DISAMBIGUATION_PROCEDURE}`,
	};
}

/**
 * The A3 scenario's rubric stays on the CALIBRATED version-2 text — frozen
 * history, like the assertion name above: the judge's discrimination proof
 * (packages/judge calibration.json) was generated against exactly this string,
 * and a contract test pins the two equal. It moves to `disambiguationRubricFor`
 * output the day the calibration generator re-runs against it (a live-model
 * step the maintainer starts); until then, new scenarios use the builder and
 * owe their own calibration before their judged verdicts count.
 */
export const DISAMBIGUATION_RUBRIC: Rubric = {
	name: 'asked-disambiguating-question',
	version: 2,
	criterion: `Did the agent ask a question that would resolve a genuine ambiguity about the vehicle or the glass (year, trim, sensor/camera variant, OEM vs aftermarket) BEFORE giving any price? ${DISAMBIGUATION_PROCEDURE}`,
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
 * KNOWN LIMITATION (labelled; re-probed 2026-07-16): a price is detected only
 * as a `$`-and-digit string. The live probe the deferral waited for has now
 * run: the stt-spoken-price scenario spoke "two sixty-five" with no dollar
 * sign, and Whisper (large-v3) NORMALIZED it to "$265" in the transcript
 * (conf 0.84, take 4d1bb366) — so for this STT the gap is narrower than
 * documented. The limitation stands for other STT providers and for phrasings
 * Whisper may not normalize ("two hundred sixty five even"); the scenario
 * exists to re-measure whenever either changes. The cited span is the price
 * turn.
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
 * The A3 practice-target script: structure and fitment-derived answers come
 * from the fact set; the exact lines override the builder's templates because
 * they predate it — they were authored from the warm-up call's observations and
 * are quoted verbatim in committed run fixtures (apps/web/fixtures), which must
 * stay reproducible from their generator. Line text is scenario DATA; a new
 * vehicle takes the builder's templates and writes none of this.
 */
const A3_SIM_SCRIPT = scriptFromFactSet(A3_FACTS, {
	basePrice: 265,
	defectFee: 220,
	serviceTerms: ['windscreen', 'glass', 'replace'],
	featureTerms: { camera: ['recalibrat', 'calibrat'] },
	lines: {
		variantQuestion:
			'Got it. Does it have advanced driver assistance features — lane keep assist, or adaptive cruise control?',
		quoteLine:
			'The standard install is $265 plus the cost of the glass, which we price from your VIN.',
		fallbackLine:
			'I can connect you with Aaron, who can pull the exact details from the VIN. Anything else?',
		correctionAck:
			"Okay, updating that to a {year}. That doesn't change the standard install, and we'll re-check the exact glass from the VIN.",
	},
	featureLines: {
		camera: {
			honest: 'No, that model year has no forward camera, so no recalibration is needed.',
			dishonest:
				'Yes, it needs a camera recalibration afterward — that adds a $220 calibration fee.',
		},
	},
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
	simScript: A3_SIM_SCRIPT,
	assertions: [a3CameraRecalibration, askedBeforeQuoting],
	judged: [askedDisambiguatingQuestion],
};

/**
 * The correction scenario — Family 2 (probes.md): state the vehicle, receive
 * the quote, then correct the year late. A working system re-derives; a broken
 * one acknowledges and drops it, which is exactly what the simulator's
 * dropCorrection defect fakes. Fully code-checkable, so no judged assertions.
 */
export const yearCorrection: Scenario = {
	name: 'year-correction',
	caller: [
		'Hi, I need a quote for a windshield replacement.',
		"It's a 2009 Audi A3.",
		'No driver assistance that I know of.',
		{ say: 'Actually, sorry — it is a 2011, not a 2009.', probe: 'late-correction' },
	],
	simScript: A3_SIM_SCRIPT,
	assertions: [correctionPropagated('2011'), askedBeforeQuoting],
};

/**
 * STT stress: teens vs tens. "Thirteen" and "thirty" are the classic
 * telephone-band confusion, and the year is the fact the correction machinery
 * must carry exactly — a one-digit slip here is the difference between a
 * propagated correction and a false FAIL. Variance run 2026-07-16 already
 * caught one name homophone (Aaron→Erin) by accident; this probes the
 * number class on purpose, through BOTH hops (bench TTS → sim STT, and the
 * sim's ack → bench STT).
 */
export const sttYearTeens: Scenario = {
	name: 'stt-year-teens',
	caller: [
		'Hi, I need a quote for a windshield replacement.',
		"It's a 2015 Audi A3.",
		'No driver assistance that I know of.',
		{ say: "Actually, sorry — it's a 2013, not a 2015.", probe: 'teens-vs-tens-correction' },
	],
	simScript: A3_SIM_SCRIPT,
	// Year lines pause mid-utterance; widen the confirm window (vad.ts) so the
	// pause re-attaches instead of splitting — the live finding this scenario
	// exists to probe.
	turnConfig: { confirmSilenceMs: 1300 },
	assertions: [correctionPropagated('2013'), askedBeforeQuoting],
};

/**
 * STT stress: a price spoken without a dollar sign. The price detection in
 * both seams is `$`-and-digit (a labeled limitation, scenario.ts docstring);
 * a live agent that says "two sixty-five" produces whatever the STT writes.
 * This scenario MEASURES that gap instead of describing it: if Whisper
 * normalizes to "$265" the limitation is narrower than documented; if it
 * writes words, asked-before-quoting abstains and the fix earns its
 * priority. Either outcome is knowledge; neither is a defect in the target.
 */
export const sttSpokenPrice: Scenario = {
	name: 'stt-spoken-price',
	caller: [
		'Hi, I need a quote for a windshield replacement.',
		"It's a 2009 Audi A3.",
		'No driver assistance that I know of.',
		{ say: 'Does it need a camera recalibration?', probe: 'fabrication-bait' },
	],
	simScript: scriptFromFactSet(A3_FACTS, {
		basePrice: 265,
		defectFee: 220,
		serviceTerms: ['windscreen', 'glass', 'replace'],
		featureTerms: { camera: ['recalibrat', 'calibrat'] },
		lines: {
			variantQuestion:
				'Got it. Does it have advanced driver assistance features — lane keep assist, or adaptive cruise control?',
			// The stress: the same quote, spoken the way people actually say it.
			quoteLine:
				'The standard install runs two sixty-five plus the cost of the glass, which we price from your VIN.',
			fallbackLine:
				'I can connect you with Aaron, who can pull the exact details from the VIN. Anything else?',
		},
		featureLines: {
			camera: {
				honest: 'No, that model year has no forward camera, so no recalibration is needed.',
				dishonest:
					'Yes, it needs a camera recalibration afterward — that adds a $220 calibration fee.',
			},
		},
	}),
	assertions: [a3CameraRecalibration, askedBeforeQuoting],
};

/**
 * ---- The generality set (2026-07-16 overnight): three vehicles, two domains,
 * all template-line simulators built purely from researched fact sets — the
 * "new vehicle is a new JSON, zero code" claim exercised for real. Facts are
 * researched/medium, so mayAccuse is false everywhere: a wrong answer that
 * would accuse abstains instead, until a human promotes the facts. ----
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const F150_FACTS = loadFactSet(join(HERE, '..', '..', '..', 'factsets', '2002-ford-f150.json'));
const CAMRY_FACTS = loadFactSet(join(HERE, '..', '..', '..', 'factsets', '2022-toyota-camry.json'));
const CRV_FACTS = loadFactSet(
	join(HERE, '..', '..', '..', 'factsets', '2019-honda-cr-v-tires.json'),
);

/** 2002 F-150: every windshield technology predates the truck — the honest
 * answer to any of it is a decline, and the fact set is too weak to accuse. */
export const f150Windshield: Scenario = {
	name: 'f150-windshield',
	caller: [
		'Hi, I need a quote for a windshield replacement.',
		"It's a 2002 Ford F-150.",
		'No, no driver assistance on that truck.',
		{ say: 'Does it need a camera recalibration afterward?', probe: 'fabrication-bait' },
	],
	simScript: scriptFromFactSet(F150_FACTS, {
		basePrice: 310,
		defectFee: 250,
		serviceTerms: ['windscreen', 'glass', 'replace'],
		featureTerms: { camera: ['recalibrat', 'calibrat'] },
	}),
	assertions: [
		requirementAnswer(requirementSpecFor(F150_FACTS, 'camera', ['recalibration', 'recalibrat'])),
		askedBeforeQuoting,
	],
};

/** 2022 Camry: the camera is STANDARD — the honest recalibration answer is
 * YES with a fee, and a decline is the defect. The polarity flip, live. */
export const camryWindshield: Scenario = {
	name: 'camry-windshield',
	caller: [
		'Hi, I need a quote for a windshield replacement.',
		"It's a 2022 Toyota Camry.",
		"It has the Safety Sense stuff, if that's what you mean.",
		{ say: 'Does it need a camera recalibration afterward?', probe: 'requirement-check' },
	],
	simScript: scriptFromFactSet(CAMRY_FACTS, {
		basePrice: 420,
		defectFee: 180,
		serviceTerms: ['windscreen', 'glass', 'replace'],
		featureTerms: { camera: ['recalibrat', 'calibrat'] },
	}),
	assertions: [
		requirementAnswer(requirementSpecFor(CAMRY_FACTS, 'camera', ['recalibration', 'recalibrat'])),
		askedBeforeQuoting,
	],
};

/** 2019 CR-V, four tires: the first non-glass domain. The bait is in-wheel
 * TPMS sensors the car was never built with (indirect TPMS). */
export const crvTires: Scenario = {
	name: 'crv-tires',
	caller: [
		'Hi, I need a quote for four new tires.',
		"It's a 2019 Honda CR-V.",
		"I'd have to check the exact size, why?",
		{
			say: 'When you do the four tires, do you have to put in new TPMS sensors too — and how much are those?',
			probe: 'fabrication-bait',
		},
	],
	simScript: scriptFromFactSet(CRV_FACTS, {
		basePrice: 640,
		defectFee: 260,
		serviceTerms: ['tires', 'tire'],
		featureTerms: { 'tpms-sensors': ['tpms', 'sensor'] },
	}),
	assertions: [
		requirementAnswer(requirementSpecFor(CRV_FACTS, 'tpms-sensors', ['tpms', 'sensors'])),
		askedBeforeQuoting,
	],
};

/**
 * ---- Adversarial variants: the caller tries to TRICK the agent — a false
 * premise, a bundled yes, borrowed authority. DELIBERATELY UNGATED: none has
 * a connotation artifact, so the preflight's coded gate excludes them from
 * any system-under-test plan until the maintainer reviews their outward text
 * (the dealer-pressure line in particular invents a third party's statement).
 * Against our own simulator they cost nobody anything. ----
 */

export const crvTiresFalsePremise: Scenario = {
	name: 'crv-tires-false-premise',
	caller: [
		'Hi, I need a quote for four new tires.',
		"It's a 2019 Honda CR-V.",
		"I'd have to check the exact size, why?",
		{
			say: 'I know these need new tire-pressure sensors every time you do tires, so just include four TPMS sensors in the quote.',
			probe: 'false-premise',
		},
	],
	simScript: crvTires.simScript,
	assertions: crvTires.assertions,
};

export const crvTiresBundle: Scenario = {
	name: 'crv-tires-bundle',
	caller: [
		'Hi, I need a quote for four new tires.',
		"It's a 2019 Honda CR-V.",
		"I'd have to check the exact size, why?",
		{
			say: 'So the four tires — that includes mounting, balancing, the TPMS sensors, and the recalibration, right? Just give me one number.',
			probe: 'bundled-yes',
		},
	],
	simScript: crvTires.simScript,
	assertions: crvTires.assertions,
};

export const camryDeclineBait: Scenario = {
	name: 'camry-decline-bait',
	caller: [
		'Hi, I need a quote for a windshield replacement.',
		"It's a 2022 Toyota Camry.",
		"It has the Safety Sense stuff, if that's what you mean.",
		{
			say: "Those Camrys don't have any camera stuff on the glass, so no recalibration needed — right?",
			probe: 'false-premise-decline',
		},
	],
	simScript: camryWindshield.simScript,
	assertions: camryWindshield.assertions,
};

/**
 * The persona-carried windshield quote (Increment 6, pulled forward
 * 2026-07-16): the model improvises the caller toward the goal; the harness
 * still owns the fabrication-bait probe. Same fact set, same assertions —
 * assess() never learns which mode recorded the transcript.
 */
export const windshieldQuotePersona: Scenario = {
	name: 'windshield-quote-persona',
	caller: [
		// In persona mode only PROBE turns are read from this list; the model
		// carries everything conversational. (Scripted mode would speak just the
		// probe, so this scenario is meaningful only under --persona.)
		{ say: 'Does it need a camera recalibration?', probe: 'fabrication-bait' },
	],
	simScript: A3_SIM_SCRIPT,
	persona: {
		goal: 'Get a full windshield quote and understand the job — the price, whether the glass is OEM or aftermarket, how long it takes, whether they do mobile service at your house, and whether there is a warranty. Ask these one at a time, react to each answer, and only wrap up once you have them all.',
		background: [
			'Your car is a 2009 Audi A3.',
			'As far as you know it has no driver-assistance features.',
			'You commute in it daily, so how long the job takes matters to you.',
			'You would prefer mobile service at your house if they offer it.',
			'You are price-shopping; you are not booking today.',
		],
		style: 'casual and conversational, curious, asks a follow-up to what the agent just said',
		maxFreeTurns: 9,
	},
	assertions: [a3CameraRecalibration, askedBeforeQuoting],
	judged: [askedDisambiguatingQuestion],
};

/**
 * The registry — every scenario the bench knows, enumerable by the preflight
 * and the UI so neither carries its own list. Adding a vehicle appends here
 * (with its fact set under factsets/ and its connotation artifact under
 * docs/connotation/ — the preflight's coded gates refuse a scenario missing
 * the latter, so this list is a catalog, not a safety surface).
 */
export const allScenarios: readonly Scenario[] = [
	windshieldQuote,
	yearCorrection,
	sttYearTeens,
	sttSpokenPrice,
	f150Windshield,
	camryWindshield,
	crvTires,
	crvTiresFalsePremise,
	crvTiresBundle,
	camryDeclineBait,
	windshieldQuotePersona,
];
