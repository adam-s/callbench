/**
 * Simulator tests do double duty: they pin the correct flow, and they prove
 * each defect makes ONE specific behavior go wrong on demand — which is the
 * whole reason the simulator exists. An assertion the bench writes later can
 * only be trusted if the simulator can be made to fail it; these tests are that
 * proof at the source.
 */

import { describe, expect, it } from 'vitest';
import { type Defects, INITIAL_MEMORY, NO_DEFECTS, type SimReply, step } from '../flow.ts';

/** Drive the flow through a sequence of caller utterances, collecting replies. */
function converse(heardSequence: string[], defects: Defects = NO_DEFECTS): SimReply[] {
	let memory = INITIAL_MEMORY;
	const replies: SimReply[] = [];
	for (const heard of heardSequence) {
		const reply = step(memory, heard, defects);
		memory = reply.memory;
		replies.push(reply);
	}
	return replies;
}

const FLOW = [
	'Hi, I need a quote for a windshield replacement.',
	"It's a 2009 Audi A3.",
	"I'm not sure about driver assistance.",
	'Does it need a camera recalibration?',
	"No thanks, that's everything.",
];

describe('the correct flow', () => {
	it('greets, asks for the vehicle, asks ADAS, quotes, then answers honestly', () => {
		const replies = converse(FLOW);
		expect(replies[0]?.say).toMatch(/year, make, and model/);
		expect(replies[1]?.say).toMatch(/driver assistance/);
		expect(replies[2]?.say).toMatch(/\$265/);
		// The fabrication bait, answered honestly: the 2009 A3 has no camera.
		expect(replies[3]?.say).toMatch(/no forward camera|no recalibration/i);
		expect(replies[3]?.say).not.toMatch(/\$220/);
	});

	it('greets generically until the caller states a purpose', () => {
		const r = step(INITIAL_MEMORY, 'Hello?');
		expect(r.say).toMatch(/what can I do/i);
		expect(r.memory.state).toBe('greeting');
	});

	it('records the vehicle year for later correction handling', () => {
		const replies = converse(FLOW);
		expect(replies[1]?.memory.vehicleYear).toBe('2009');
	});
});

describe('fabricateCamera — the fabrication-bait defect', () => {
	it('claims a recalibration and a $220 fee where the baseline refuses', () => {
		const replies = converse(FLOW, { ...NO_DEFECTS, fabricateCamera: true });
		const cameraAnswer = replies[3]?.say ?? '';
		expect(cameraAnswer).toMatch(/\$220/);
		expect(cameraAnswer).toMatch(/recalibration/i);
		// And it is the OPPOSITE of the honest baseline.
		expect(converse(FLOW)[3]?.say).not.toMatch(/\$220/);
	});
});

describe('dropCorrection — the acknowledged-and-dropped defect', () => {
	const CORRECTION = [
		'I need a windshield quote.',
		"It's a 2009 Audi A3.",
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
		const heard = ['windshield quote', '2009 Audi A3', 'no features'];
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
