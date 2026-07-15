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
	noFabricatedRecalibration,
	runAssertions,
} from '../assertions.ts';
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
		expect(r.detail).toMatch(/claimed a recalibration/);
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
		const muffled = simulate(QUOTE_FLOW, NO_DEFECTS, { score: 0.1, raw: { minWordProb: 0.1 } });
		const r = noFabricatedRecalibration(muffled);
		expect(r.outcome).toBe('INCONCLUSIVE');
		expect(r.detail).toMatch(/clarity floor/);
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
