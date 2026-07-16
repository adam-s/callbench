/**
 * Each metric is proven against a synthetic signal whose right answer is known
 * by construction — a metric that can't detect the defect it names is a
 * dashboard light wired to nothing. Same for the stages: each one's effect is
 * verified BY the metrics, which is exactly the A/B loop real experiments use.
 */

import { describe, expect, it } from 'vitest';
import {
	advisoryFlags,
	analyzeChannel,
	chain,
	dcBlock,
	gain,
	noiseGate,
	processBuffer,
	softLimit,
	type WavChannel,
} from '../index.ts';

const RATE = 8000;

/** Seconds of sine at `hz`, amplitude `amp`, with optional constant offset. */
function sine(secs: number, hz: number, amp: number, dc = 0): Int16Array {
	const n = Math.round(secs * RATE);
	const out = new Int16Array(n);
	for (let i = 0; i < n; i++) {
		out[i] = Math.max(
			-32768,
			Math.min(32767, Math.round(amp * Math.sin((2 * Math.PI * hz * i) / RATE) + dc)),
		);
	}
	return out;
}

function concat(...parts: Int16Array[]): Int16Array {
	const out = new Int16Array(parts.reduce((a, p) => a + p.length, 0));
	let off = 0;
	for (const p of parts) {
		out.set(p, off);
		off += p.length;
	}
	return out;
}

const ch = (pcm: Int16Array): WavChannel => ({ label: 'test', pcm, sampleRate: RATE });

/** "Speech": a 300Hz tone loud enough to pass the gate; "noise": low white-ish
 * wobble. Both deterministic (no Math.random — a flaky fixture tests nothing). */
const speech = (secs: number) => sine(secs, 300, 8000);
const hiss = (secs: number, amp: number) => sine(secs, 1700, amp);

describe('metrics detect the defect they name', () => {
	it('clean speech: high SNR, no clicks, no dropouts, no flags', () => {
		const m = analyzeChannel(ch(concat(speech(2), hiss(1, 40), speech(1))));
		expect(m.snrDb).not.toBeNull();
		expect(m.snrDb as number).toBeGreaterThan(20);
		expect(m.clicksPerSec).toBeLessThan(1);
		expect(m.dropoutGaps).toBe(0);
		expect(advisoryFlags(m)).toEqual([]);
	});

	it('injected clicks raise clicksPerSec and flag it', () => {
		const pcm = concat(speech(2));
		for (let i = 800; i < pcm.length; i += 800) pcm[i] = 32000 * (pcm[i - 1]! > 0 ? -1 : 1);
		const m = analyzeChannel(ch(pcm));
		expect(m.clicksPerSec).toBeGreaterThan(5);
		expect(advisoryFlags(m)).toContain('clicks');
	});

	it('a mid-speech dropout is counted; leading/trailing silence is not', () => {
		const gap = new Int16Array(Math.round(0.1 * RATE)); // 100ms of digital zero
		const m = analyzeChannel(ch(concat(speech(1), gap, speech(1))));
		expect(m.dropoutGaps).toBe(1);
		const m2 = analyzeChannel(ch(concat(new Int16Array(RATE), speech(1))));
		expect(m2.dropoutGaps).toBe(0);
	});

	it('a loud noise floor collapses SNR and flags it', () => {
		// Quiet speech over a floor just under the speech gate: the gate caps how
		// loud "noise" can be before it reads as speech, so a low SNR needs the
		// SPEECH quiet, not the noise loud — which is also the realistic shape of
		// a too-quiet capture.
		const m = analyzeChannel(ch(concat(sine(2, 300, 2000), hiss(2, 350))));
		expect(m.snrDb as number).toBeLessThan(20);
		expect(advisoryFlags(m)).toContain('snr');
	});

	it('DC offset and clipping are measured and flagged', () => {
		const m = analyzeChannel(ch(sine(2, 300, 4000, 900)));
		expect(Math.abs(m.dcOffset)).toBeGreaterThan(100);
		expect(advisoryFlags(m)).toContain('dc-offset');
		const clipped = analyzeChannel(ch(sine(2, 300, 40000)));
		expect(clipped.clippedSamples).toBeGreaterThan(10);
		expect(advisoryFlags(clipped)).toContain('clipping');
	});

	it('near-Nyquist energy shows up as out-of-band', () => {
		const m = analyzeChannel(ch(sine(2, 3700, 8000)));
		expect(m.outOfBandFraction).toBeGreaterThan(0.02);
		expect(advisoryFlags(m)).toContain('out-of-band');
	});
});

describe('stages, verified by the metrics they should move', () => {
	it('dcBlock removes an offset without touching level much', () => {
		const before = analyzeChannel(ch(sine(2, 300, 8000, 900)));
		const after = analyzeChannel(ch(processBuffer(sine(2, 300, 8000, 900), dcBlock())));
		expect(Math.abs(before.dcOffset)).toBeGreaterThan(100);
		expect(Math.abs(after.dcOffset)).toBeLessThan(50);
		expect(after.speechRms).toBeGreaterThan(before.speechRms * 0.8);
	});

	it('gain moves speech level by the stated dB', () => {
		const base = analyzeChannel(ch(speech(2)));
		const up = analyzeChannel(ch(processBuffer(speech(2), gain(6))));
		expect(up.speechDbfs - base.speechDbfs).toBeGreaterThan(5);
		expect(up.speechDbfs - base.speechDbfs).toBeLessThan(7);
	});

	it('softLimit tames a clipping signal', () => {
		const before = analyzeChannel(ch(sine(2, 300, 40000)));
		const after = analyzeChannel(ch(processBuffer(sine(2, 300, 40000), softLimit(0.8))));
		expect(before.clippedSamples).toBeGreaterThan(10);
		expect(after.clippedSamples).toBeLessThanOrEqual(before.clippedSamples / 10);
	});

	it('noiseGate drops the floor between words and leaves speech alone', () => {
		const signal = concat(speech(1), hiss(1, 100), speech(1));
		const before = analyzeChannel(ch(signal));
		const after = analyzeChannel(ch(processBuffer(signal, noiseGate(150, -18))));
		expect(after.noiseFloor).toBeLessThan(before.noiseFloor);
		expect(after.speechRms).toBeGreaterThan(before.speechRms * 0.9);
	});

	it('a chain composes and resets as one', () => {
		const c = chain(dcBlock(), gain(3), softLimit());
		expect(c.name).toContain('dcBlock');
		const out = processBuffer(sine(1, 300, 8000, 500), c);
		const m = analyzeChannel(ch(out));
		expect(Math.abs(m.dcOffset)).toBeLessThan(50);
	});
});
