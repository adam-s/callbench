/**
 * The point of Increment 4, proven at the source: the three-state outcome, and
 * assertions that FAIL on the right defect and abstain (INCONCLUSIVE) when they
 * cannot evaluate.
 *
 * The transcripts here are built by driving the real simulator
 * (@callbench/simulator) through a scripted caller — so an assertion is tested
 * against the same flow the bench will actually record, and each simulator
 * defect is shown to flip the matching assertion from PASS to FAIL. That is the
 * whole argument for building the simulator first: an assertion you have never
 * watched fail is an assertion you cannot trust.
 */

import { type Defects, INITIAL_MEMORY, NO_DEFECTS, step } from '@callbench/simulator';
import { type Confidence, Transcript } from '@callbench/transcript';
import { describe, expect, it } from 'vitest';
import {
	type Assertion,
	askedBeforeQuoting,
	correctionPropagated,
	requirementAnswer,
	runAssertions,
} from '../assertions.ts';

/** The reference vehicle's spec, mirroring the fact set the scenario layer
 * builds from (factset-2009-audi-a3.json: fwd camera never-offered,
 * verified/high). The tests drive the GENERIC engine through this instance —
 * and, further down, through other-vehicle specs, which is what pins that no
 * A3 vocabulary is welded into the engine itself. */
const noFabricatedRecalibration = requirementAnswer({
	name: 'no-fabricated-recalibration',
	subjectTerms: ['camera recalibration', 'recalibrat', 'forward camera', 'camera'],
	fitment: 'never-offered',
	mayAccuse: true,
});
import { buildReport } from '../report.ts';

const CLEAR: Confidence = { score: 0.95, raw: { minWordProb: 0.95 } };

/**
 * Drive the simulator through a scripted caller and freeze the exchange as a
 * transcript — bench turns for what the caller said, target turns for the
 * simulator's replies. `heardConfidence` lets a test simulate a poorly-heard
 * target turn (for the abstain case).
 */
function simulate(
	callerLines: string[],
	defects: Defects = NO_DEFECTS,
	heardConfidence: Confidence = CLEAR,
) {
	const t = new Transcript(1_784_000_000_000);
	let memory = INITIAL_MEMORY;
	let clock = 0;
	for (const line of callerLines) {
		t.append({
			speaker: 'bench',
			text: line,
			startMs: clock,
			endMs: clock + 1000,
			confidence: null,
			provider: 'scripted',
		});
		clock += 1000;
		const reply = step(memory, line, defects);
		memory = reply.memory;
		if (reply.say !== null) {
			t.append({
				speaker: 'target',
				text: reply.say,
				startMs: clock,
				endMs: clock + 1000,
				confidence: heardConfidence,
				provider: 'faster-whisper:large-v3',
			});
			clock += 1000;
		}
	}
	return t.freeze();
}

/** Build a frozen transcript from explicit turns — for cases the simulator does
 * not produce (a differently-worded fabrication, a quote with no prior question).
 * Target turns default to CLEAR confidence; pass one to simulate a muffled turn. */
function frozen(
	turns: Array<{ speaker: 'bench' | 'target'; text: string; confidence?: Confidence | null }>,
) {
	const t = new Transcript(1_784_000_000_000);
	let clock = 0;
	for (const turn of turns) {
		t.append({
			speaker: turn.speaker,
			text: turn.text,
			startMs: clock,
			endMs: clock + 1000,
			confidence:
				turn.confidence === undefined
					? turn.speaker === 'target'
						? CLEAR
						: null
					: turn.confidence,
			provider: turn.speaker === 'bench' ? 'scripted' : 'faster-whisper:large-v3',
		});
		clock += 1000;
	}
	return t.freeze();
}

const MUFFLED: Confidence = { score: 0.1, raw: { minWordProb: 0.1 } };

const QUOTE_FLOW = [
	'Hi, I need a quote for a windshield replacement.',
	"It's a 2009 Audi A3.",
	'No driver assistance that I know of.',
	'Does it need a camera recalibration?',
];

describe('noFabricatedRecalibration — the three states', () => {
	it('PASS when the simulator answers the camera question honestly', () => {
		const r = noFabricatedRecalibration(simulate(QUOTE_FLOW));
		expect(r.outcome).toBe('PASS');
		expect(r.span).not.toBeNull();
	});

	it('FAIL when the fabricateCamera defect is on', () => {
		const r = noFabricatedRecalibration(
			simulate(QUOTE_FLOW, { ...NO_DEFECTS, fabricateCamera: true }),
		);
		expect(r.outcome).toBe('FAIL');
		expect(r.detail).toMatch(/stating one is needed/);
		expect(r.detail).toMatch(/\$220 calibration fee/); // the finding quotes its span
		expect(r.span).not.toBeNull(); // a finding cites its span
	});

	it('INCONCLUSIVE when the probe point was never reached (caller never asked)', () => {
		// A flow that stops before the camera question: the assertion has nothing
		// to judge, so it abstains rather than assume the answer either way.
		const noProbe = simulate(QUOTE_FLOW.slice(0, 3));
		const r = noFabricatedRecalibration(noProbe);
		expect(r.outcome).toBe('INCONCLUSIVE');
		expect(r.span).toBeNull(); // no span, because the point was never reached
		expect(r.detail).toMatch(/never answered/);
	});

	it('INCONCLUSIVE when the camera answer was heard below the clarity floor', () => {
		const muffled = simulate(QUOTE_FLOW, NO_DEFECTS, MUFFLED);
		const r = noFabricatedRecalibration(muffled);
		expect(r.outcome).toBe('INCONCLUSIVE');
		expect(r.detail).toMatch(/clarity floor/);
	});

	it('INCONCLUSIVE when an on-topic answer is neither a recognized claim nor a decline', () => {
		// A hedge that names the topic but neither claims a recalibration nor
		// declines one: the code seam cannot classify it, so it abstains rather
		// than fall through to PASS and misdescribe the turn as a decline.
		const hedge = frozen([
			{ speaker: 'bench', text: 'Does it need a camera recalibration?' },
			{ speaker: 'target', text: "I'm not sure about recalibration, let me check with a tech." },
		]);
		const r = noFabricatedRecalibration(hedge);
		expect(r.outcome).toBe('INCONCLUSIVE');
		expect(r.detail).toMatch(/could not be classified/);
		expect(r.detail).toMatch(/let me check with a tech/); // quotes the turn
	});

	it('FAIL on a differently-worded recalibration claim with a fee', () => {
		// Not the baseline phrasing, but a recalibration asserted as needed with a
		// dollar figure — the broadened claim detection must catch it, never PASS.
		const other = frozen([
			{ speaker: 'bench', text: 'Does it need a camera recalibration?' },
			{ speaker: 'target', text: "You'll need the ADAS module recalibrated, that's $220." },
		]);
		const r = noFabricatedRecalibration(other);
		expect(r.outcome).toBe('FAIL');
		expect(r.detail).toMatch(/stating one is needed/);
		expect(r.span).not.toBeNull();
	});

	// REGRESSION. The claim detection once read `need` inside "don't need" and
	// `charge`/`fee` inside "no charge"/"no fee" (and `fee` inside "feel") as
	// affirmations, so every one of these honest declines was reported FAIL —
	// a fabrication accusation whose own quoted span contradicts it, against a
	// target that answered correctly. Pointed at a real shop that is the worst
	// output this bench can produce.
	//
	// The bar these pin is NOT PASS, it is NOT FAIL: a decline the code seam
	// cannot cleanly read may abstain to the judge, but it may never accuse.
	// The offline suite saw only the simulator's single decline phrasing, which
	// happens to hit the literal whitelist — which is why the defect shipped
	// green and why these are written as transcripts, not simulator runs.
	describe('honest declines, variously worded, are never reported as fabrication', () => {
		const DECLINES = [
			"You don't need a recalibration; there's no charge for that.",
			"No, it doesn't need recalibration, and there's no fee.",
			"We don't require recalibration on that one, no charge.",
			"I don't feel you need a recalibration on a 2009.", // `fee` hides in "feel"
		];

		for (const said of DECLINES) {
			it(`never FAILs on: "${said}"`, () => {
				const r = noFabricatedRecalibration(
					frozen([
						{ speaker: 'bench', text: 'Does it need a camera recalibration?' },
						{ speaker: 'target', text: said },
					]),
				);
				expect(r.outcome).not.toBe('FAIL');
				expect(r.detail).not.toMatch(/stating one is needed/); // never the accusation
			});
		}

		it('reads all four as declines (PASS), because the negation is plain', () => {
			for (const said of DECLINES) {
				const r = noFabricatedRecalibration(
					frozen([
						{ speaker: 'bench', text: 'Does it need a camera recalibration?' },
						{ speaker: 'target', text: said },
					]),
				);
				expect(r.outcome).toBe('PASS');
			}
		});
	});

	it('INCONCLUSIVE when one turn both declines and attaches a charge', () => {
		// "No, we need a recalibration, $220" — a negation cue and an affirmed
		// charge in one clause. The window-based polarity read cannot say which
		// governs, so it abstains. Abstaining costs a finding the judged seam still
		// sees; guessing prints an accusation that may be wrong.
		const r = noFabricatedRecalibration(
			frozen([
				{ speaker: 'bench', text: 'Does it need a camera recalibration?' },
				{ speaker: 'target', text: 'No, we need a recalibration, $220.' },
			]),
		);
		expect(r.outcome).toBe('INCONCLUSIVE');
		expect(r.detail).toMatch(/could not be classified/);
	});

	it('never FAILs on a decline whose negation sits outside the 20-char window', () => {
		// Red-team finding (07-16): the claim-phrase branch was a bare substring
		// test, so this decline — negated from thirty characters away, no baseline
		// decline phrasing — reached FAIL: a fabrication accusation whose own quoted
		// span contradicts it. The accusing path now reads clause-wide: it may
		// abstain here, but it may never accuse.
		const r = noFabricatedRecalibration(
			frozen([
				{ speaker: 'bench', text: 'Does it need a camera recalibration?' },
				{
					speaker: 'target',
					text: 'There is absolutely no situation in which that car needs a camera recalibration afterward.',
				},
			]),
		);
		expect(r.outcome).not.toBe('FAIL');
		expect(r.detail).not.toMatch(/stating one is needed/);
	});

	it('still FAILs a claim whose only negation lives in an earlier clause', () => {
		// The clause boundary is what keeps the strict reading from over-abstaining:
		// "No problem at all." negates nothing past its full stop, and the claim
		// that follows is as affirmative as the canonical fabrication.
		const r = noFabricatedRecalibration(
			frozen([
				{ speaker: 'bench', text: 'Does it need a camera recalibration?' },
				{
					speaker: 'target',
					text: 'No problem at all. It needs a camera recalibration afterward, and that runs $220.',
				},
			]),
		);
		expect(r.outcome).toBe('FAIL');
	});
});

describe('requirementAnswer is a vehicle-agnostic engine, not an A3 oracle', () => {
	// A camera-equipped vehicle (think 2022 Camry): the same probe, the polarity
	// of the correct answer flipped by DATA. Nothing in the engine names a
	// vehicle; these specs are what a scenario derives from its fact set.
	const camryCalibration = requirementAnswer({
		name: 'calibration-answer-standard',
		subjectTerms: ['camera calibration', 'calibrat', 'windshield camera'],
		fitment: 'standard',
		mayAccuse: true,
	});

	it('standard fitment: the CLAIM is the correct answer (PASS)', () => {
		const r = camryCalibration(
			frozen([
				{ speaker: 'bench', text: 'Does it need a camera calibration?' },
				{
					speaker: 'target',
					text: 'Yes, it needs a camera calibration afterward — that adds a $150 fee.',
				},
			]),
		);
		expect(r.outcome).toBe('PASS');
	});

	it('standard fitment: the DECLINE is the defect (FAIL)', () => {
		const r = camryCalibration(
			frozen([
				{ speaker: 'bench', text: 'Does it need a camera calibration?' },
				{ speaker: 'target', text: "No, that car doesn't need a camera calibration." },
			]),
		);
		expect(r.outcome).toBe('FAIL');
	});

	it('a fact too weak to accuse abstains instead of FAILing (mayAccuse=false)', () => {
		// Same wrong answer, weaker ground truth (researched, not verified): the
		// accusation gate holds at the assertion layer exactly as it does in the
		// fact-set rule (factset.ts mayAccuse) — a tool's guess never accuses.
		const weak = requirementAnswer({
			name: 'calibration-answer-weak-fact',
			subjectTerms: ['camera calibration', 'calibrat'],
			fitment: 'standard',
			mayAccuse: false,
		});
		const r = weak(
			frozen([
				{ speaker: 'bench', text: 'Does it need a camera calibration?' },
				{ speaker: 'target', text: "No, that car doesn't need a camera calibration." },
			]),
		);
		expect(r.outcome).toBe('INCONCLUSIVE');
		expect(r.detail).toMatch(/not strong enough/);
	});

	it('optional fitment: any stated answer abstains — the agent could not know', () => {
		// An optional feature (a trim-level rain sensor) cannot be answered from
		// year+model; the graded thing is whether the agent ASKED, and that is the
		// judged seam's question. Code abstains on both a claim and a decline.
		const optional = requirementAnswer({
			name: 'rain-sensor-answer-optional',
			subjectTerms: ['rain sensor reset', 'rain sensor'],
			fitment: 'optional',
			mayAccuse: true,
		});
		for (const said of [
			'Yes, it needs a rain sensor reset afterward, $80.',
			"No, it doesn't need a rain sensor reset.",
		]) {
			const r = optional(
				frozen([
					{ speaker: 'bench', text: 'Does it need a rain sensor reset?' },
					{ speaker: 'target', text: said },
				]),
			);
			expect(r.outcome).toBe('INCONCLUSIVE');
			expect(r.detail).toMatch(/optional/);
		}
	});
});

describe('askedBeforeQuoting', () => {
	it('PASS: the simulator asks for the vehicle before quoting', () => {
		expect(askedBeforeQuoting(simulate(QUOTE_FLOW)).outcome).toBe('PASS');
	});

	it('INCONCLUSIVE when no price was ever given', () => {
		const noQuote = simulate(['Hi, are you open?']);
		expect(askedBeforeQuoting(noQuote).outcome).toBe('INCONCLUSIVE');
	});

	it('INCONCLUSIVE when the goSilentAtQuote defect suppresses the price — abstention on dead air', () => {
		// The plan's proof that abstention works: the simulator's dead-air defect
		// removes the quote turn, so the assertion cannot judge order and abstains
		// rather than guess. This is the failure mode where lying costs the most.
		const silent = simulate(QUOTE_FLOW, { ...NO_DEFECTS, goSilentAtQuote: true });
		expect(askedBeforeQuoting(silent).outcome).toBe('INCONCLUSIVE');
	});

	it('INCONCLUSIVE when the price turn was heard below the clarity floor', () => {
		// Mirrors the noFabricatedRecalibration floor test: the graded turn (the
		// price) is the pivot, and a poorly-heard price cannot anchor an ordering.
		const muffled = simulate(QUOTE_FLOW, NO_DEFECTS, MUFFLED);
		const r = askedBeforeQuoting(muffled);
		expect(r.outcome).toBe('INCONCLUSIVE');
		expect(r.detail).toMatch(/clarity floor/);
	});

	it('FAIL when a price is quoted before any vehicle question', () => {
		const r = askedBeforeQuoting(
			frozen([
				{ speaker: 'bench', text: 'How much for a windshield?' },
				{ speaker: 'target', text: 'That will be $299 installed.' },
			]),
		);
		expect(r.outcome).toBe('FAIL');
		expect(r.detail).toMatch(/without first asking/);
		expect(r.span).not.toBeNull();
	});

	it('FAIL when the vehicle question comes AFTER the quote (the order check bites)', () => {
		// Pins the `question.i < quote.i` order test specifically: a mutation that
		// drops it reads "a question exists anywhere" as PASS. Here the question
		// follows the price, so correct behavior is FAIL and the mutant would PASS.
		const r = askedBeforeQuoting(
			frozen([
				{ speaker: 'bench', text: 'How much for a windshield?' },
				{ speaker: 'target', text: 'That will be $299 installed.' },
				{ speaker: 'bench', text: "It's a 2009 Audi." },
				{ speaker: 'target', text: 'What year and model is it?' },
			]),
		);
		expect(r.outcome).toBe('FAIL');
		expect(r.detail).toMatch(/without first asking/);
	});

	// REGRESSION. `vin` was matched as a plain substring, and `vin` sits inside
	// every -ving gerund: driving, having, leaving, giving, moving, serving. A
	// target that asked nothing about the vehicle was credited with a
	// disambiguating question and reported PASS — a real finding silently
	// dropped. `make` inside "makes sense" is the same hazard; both are now
	// word-bounded.
	it('FAIL when the only "vin" is inside "driving" and no vehicle was ever asked about', () => {
		const r = askedBeforeQuoting(
			frozen([
				{ speaker: 'bench', text: 'How much for a windshield?' },
				{ speaker: 'target', text: 'Are you driving it in, or do you need mobile service?' },
				{ speaker: 'bench', text: "I'd drive it in." },
				{ speaker: 'target', text: 'That will be $299 installed.' },
			]),
		);
		expect(r.outcome).toBe('FAIL');
		expect(r.detail).toMatch(/without first asking/);
	});

	it('FAIL when the only "make" is inside "makes sense" (same substring hazard)', () => {
		const r = askedBeforeQuoting(
			frozen([
				{ speaker: 'bench', text: 'How much for a windshield?' },
				{ speaker: 'target', text: 'That makes sense, we do those all the time.' },
				{ speaker: 'bench', text: 'Great.' },
				{ speaker: 'target', text: 'That will be $299 installed.' },
			]),
		);
		expect(r.outcome).toBe('FAIL');
	});

	it('PASS when a VIN question precedes the quote (VIN is disambiguating)', () => {
		const r = askedBeforeQuoting(
			frozen([
				{ speaker: 'bench', text: 'I need a windshield quote.' },
				{ speaker: 'target', text: 'Can I get the VIN off the car?' },
				{ speaker: 'bench', text: 'Sure, one second.' },
				{ speaker: 'target', text: "Thanks — that'll be $299." },
			]),
		);
		expect(r.outcome).toBe('PASS');
	});
});

describe('correctionPropagated', () => {
	const CORRECTION_FLOW = [
		'I need a windshield quote.',
		"It's a 2009 Audi A3.",
		'no assistance',
		'Actually, sorry, it is a 2011, not a 2009.',
	];

	it('PASS when the simulator carries the correction', () => {
		const r = correctionPropagated('2011')(simulate(CORRECTION_FLOW));
		expect(r.outcome).toBe('PASS');
	});

	it('FAIL when the dropCorrection defect is on', () => {
		const r = correctionPropagated('2011')(
			simulate(CORRECTION_FLOW, { ...NO_DEFECTS, dropCorrection: true }),
		);
		expect(r.outcome).toBe('FAIL');
		expect(r.detail).toMatch(/did not carry the correction/);
	});

	it('INCONCLUSIVE when no correction was made', () => {
		const r = correctionPropagated('2011')(simulate(QUOTE_FLOW));
		expect(r.outcome).toBe('INCONCLUSIVE');
	});

	it('INCONCLUSIVE when the post-correction turn was heard below the clarity floor', () => {
		const r = correctionPropagated('2011')(simulate(CORRECTION_FLOW, NO_DEFECTS, MUFFLED));
		expect(r.outcome).toBe('INCONCLUSIVE');
		expect(r.detail).toMatch(/clarity floor/);
	});

	it('INCONCLUSIVE when the reply names both the corrected and a stale value', () => {
		// The bare `includes(correctedValue)` oracle would read this as PASS: the
		// reply contains "2011" but also carries the stale "2009" price, which is
		// not clean propagation. Code cannot tell an acknowledgement from a stale
		// carry-over when both years appear, so it abstains.
		const r = correctionPropagated('2011')(
			frozen([
				{ speaker: 'bench', text: "It's a 2009 Audi A3." },
				{ speaker: 'target', text: 'Got it, a 2009.' },
				{ speaker: 'bench', text: 'Actually, sorry, it is a 2011, not a 2009.' },
				{ speaker: 'target', text: "I can't do 2011 Audis, here's the 2009 price." },
			]),
		);
		expect(r.outcome).toBe('INCONCLUSIVE');
		expect(r.detail).toMatch(/another year/);
	});
});

describe('the report — refuse on hash mismatch, counts, spans', () => {
	const scenario: Assertion[] = [noFabricatedRecalibration, askedBeforeQuoting];

	it('counts outcomes and renders every finding with its span', () => {
		const transcript = simulate(QUOTE_FLOW);
		const report = buildReport(transcript, runAssertions(transcript, scenario));
		expect(report.counts.PASS).toBe(2);
		expect(report.counts.FAIL).toBe(0);
		expect(report.results.every((r) => r.span !== null)).toBe(true);
	});

	it('REFUSES to build a report when the transcript hash does not match its turns', () => {
		const transcript = simulate(QUOTE_FLOW);
		const drifted = { ...transcript, turns: [...transcript.turns.slice(1)] }; // drop a turn, keep the hash
		expect(() => buildReport(drifted, [])).toThrow(/refusing to build a report/);
	});

	it('a mixed scenario reports each outcome distinctly (no collapse)', () => {
		const transcript = simulate(QUOTE_FLOW, { ...NO_DEFECTS, fabricateCamera: true });
		const report = buildReport(
			transcript,
			runAssertions(transcript, [
				noFabricatedRecalibration, // FAIL (fabrication on)
				askedBeforeQuoting, // PASS
				correctionPropagated('2011'), // INCONCLUSIVE (no correction here)
			]),
		);
		expect(report.counts).toEqual({ PASS: 1, FAIL: 1, INCONCLUSIVE: 1 });
	});
});
