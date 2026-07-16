/**
 * Simulator tests do double duty: they pin the correct flow, and they prove
 * each defect makes ONE specific behavior go wrong on demand — which is the
 * whole reason the simulator exists. An assertion the bench writes later can
 * only be trusted if the simulator can be made to fail it; these tests are that
 * proof at the source.
 *
 * The engine is vehicle-blind: everything it says arrives as a SimScript built
 * from a fact set. The fact set here is DECLARED — a fictional vehicle invented
 * for the test, certain because we decided it (factset.ts) — and a second,
 * standard-fitment fact set drives the same engine to the OPPOSITE honest
 * answer, which is the generality this rebuild exists to provide.
 */

import type { FactSet } from '@callbench/factset';
import { describe, expect, it } from 'vitest';
import {
	type Defects,
	INITIAL_MEMORY,
	NO_DEFECTS,
	type SimReply,
	type SimScript,
	scriptFromFactSet,
	step,
} from '../flow.ts';

const facts = (fitment: 'never-offered' | 'optional' | 'standard'): FactSet => ({
	vehicle: { id: 'test-sedan', display: '2009 Vireo Sedan 2.0T', short: 'the Vireo' },
	service: 'a windshield quote',
	callerQuestion: 'Does it need a camera recalibration afterward?',
	overloadedTerms: '"recalibration"',
	features: [
		{
			id: 'camera',
			label: 'a forward-facing camera',
			catalog: 'A windshield-mounted camera used by driver-assistance systems.',
			namedBy: 'camera, forward camera, ADAS, lane assist',
			fitment,
			confidence: 'high',
			provenance: 'declared',
			source: 'invented for this test',
		},
	],
});

const script = (fitment: 'never-offered' | 'optional' | 'standard' = 'never-offered'): SimScript =>
	scriptFromFactSet(facts(fitment), {
		basePrice: 265,
		defectFee: 220,
		serviceTerms: ['windshield', 'windscreen', 'glass', 'replace'],
		featureTerms: { camera: ['recalibrat', 'calibrat'] },
	});

/** Drive the flow through a sequence of caller utterances, collecting replies. */
function converse(
	heardSequence: string[],
	defects: Defects = NO_DEFECTS,
	s: SimScript = script(),
): SimReply[] {
	let memory = INITIAL_MEMORY;
	const replies: SimReply[] = [];
	for (const heard of heardSequence) {
		const reply = step(memory, heard, defects, s);
		memory = reply.memory;
		replies.push(reply);
	}
	return replies;
}

const FLOW = [
	'Hi, I need a quote for a windshield replacement.',
	"It's a 2009 Vireo Sedan.",
	"I'm not sure about driver assistance.",
	'Does it need a camera recalibration?',
	"No thanks, that's everything.",
];

describe('the correct flow', () => {
	it('greets, asks for the vehicle, asks the variant, quotes, then answers honestly', () => {
		const replies = converse(FLOW);
		expect(replies[0]?.say).toMatch(/year, make, and model/);
		expect(replies[1]?.say).toMatch(/forward-facing camera/); // the variant question names the hardware
		expect(replies[2]?.say).toMatch(/\$265/);
		// The fabrication bait, answered honestly: this vehicle has no camera.
		expect(replies[3]?.say).toMatch(/doesn't need/i);
		expect(replies[3]?.say).not.toMatch(/\$220/);
	});

	it('greets generically until the caller states a purpose', () => {
		const r = step(INITIAL_MEMORY, 'Hello?', NO_DEFECTS, script());
		expect(r.say).toMatch(/what can I do/i);
		expect(r.memory.state).toBe('greeting');
	});

	it('records the vehicle year for later correction handling', () => {
		const replies = converse(FLOW);
		expect(replies[1]?.memory.vehicleYear).toBe('2009');
	});

	it('falls back to the transfer offer when a question names no scripted feature', () => {
		const replies = converse([
			'windshield quote',
			'2009 Vireo Sedan',
			'not sure',
			'Do you handle insurance claims directly?',
		]);
		expect(replies[3]?.say).toMatch(/connect you/i);
	});
});

describe('fabricateAnswer — the dishonest-answer defect', () => {
	it('never-offered: claims the service and a $220 fee where the baseline declines', () => {
		const replies = converse(FLOW, { ...NO_DEFECTS, fabricateAnswer: true });
		const cameraAnswer = replies[3]?.say ?? '';
		expect(cameraAnswer).toMatch(/\$220/);
		expect(cameraAnswer).toMatch(/needs/i);
		// And it is the OPPOSITE of the honest baseline.
		expect(converse(FLOW)[3]?.say).not.toMatch(/\$220/);
	});

	it('standard: the SAME engine flips — honest claims the fee, the defect declines', () => {
		// The generality proof: no engine edit, a different fact set, and the
		// defect switch still means "wrong on purpose" — in the other direction.
		const s = script('standard');
		const honest = converse(FLOW, NO_DEFECTS, s)[3]?.say ?? '';
		expect(honest).toMatch(/\$220/);
		expect(honest).toMatch(/needs/i);
		const dishonest = converse(FLOW, { ...NO_DEFECTS, fabricateAnswer: true }, s)[3]?.say ?? '';
		expect(dishonest).toMatch(/doesn't need/i);
		expect(dishonest).not.toMatch(/\$220/);
	});

	it('optional: the honest answer is a variant question, not a verdict', () => {
		const honest = converse(FLOW, NO_DEFECTS, script('optional'))[3]?.say ?? '';
		expect(honest).toMatch(/depends on the exact variant/i);
		expect(honest).not.toMatch(/\$220/);
	});
});

describe('dropCorrection — the acknowledged-and-dropped defect', () => {
	const CORRECTION = [
		'I need a windshield quote.',
		"It's a 2009 Vireo Sedan.",
		'no assistance features',
		'Actually, sorry, it is a 2011, not a 2009.',
	];

	it('baseline: a correction updates the year and re-derives', () => {
		const replies = converse(CORRECTION);
		const correctionReply = replies[3];
		expect(correctionReply?.memory.vehicleYear).toBe('2011');
		expect(correctionReply?.say).toMatch(/2011/);
	});

	it('defect: acknowledges the correction but keeps the old year', () => {
		const replies = converse(CORRECTION, { ...NO_DEFECTS, dropCorrection: true });
		const correctionReply = replies[3];
		expect(correctionReply?.memory.vehicleYear).toBe('2009'); // never updated
		expect(correctionReply?.say).toMatch(/got it|thanks/i);
		expect(correctionReply?.say).not.toMatch(/2011/);
	});
});

describe('goSilentAtQuote — the dead-air / INCONCLUSIVE defect', () => {
	it('says nothing at the quote step where the baseline speaks', () => {
		const heard = ['windshield quote', '2009 Vireo Sedan', 'no features'];
		expect(converse(heard)[2]?.say).toMatch(/\$265/); // baseline quotes
		const silent = converse(heard, { ...NO_DEFECTS, goSilentAtQuote: true });
		expect(silent[2]?.say).toBeNull(); // defect: dead air at the probe point
		// Silence is a state transition, not a stall — the flow still advanced.
		expect(silent[2]?.memory.state).toBe('quoted');
	});
});

describe('determinism', () => {
	it('same inputs always produce the same reply', () => {
		const a = converse(FLOW);
		const b = converse(FLOW);
		expect(a.map((r) => r.say)).toEqual(b.map((r) => r.say));
	});
});
