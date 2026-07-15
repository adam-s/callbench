/**
 * μ-law codec tests. The anchor values are the G.711 facts the wire capture
 * already established from the other side: 0xFF is digital silence (decodes
 * to ~0), and encoding near-zero produces 0xFF — so our encoder's silence is
 * byte-identical to the silence Twilio actually sent us.
 */

import { describe, expect, it } from 'vitest';
import { MULAW_SILENCE } from '../../twilio/frames.ts';
import {
	decodeMulaw,
	encodePcm,
	linearToMulaw,
	mulawToLinear,
	tone,
	toneStrength,
} from '../mulaw.ts';
import g711Oracle from './g711-oracle.json' with { type: 'json' };

describe('G.711 anchors', () => {
	it('encodes silence to the byte the wire uses for silence', () => {
		expect(linearToMulaw(0)).toBe(MULAW_SILENCE);
	});

	it('decodes the wire silence byte to near-zero', () => {
		expect(Math.abs(mulawToLinear(MULAW_SILENCE))).toBeLessThanOrEqual(8);
	});

	it('round-trips across the dynamic range within mu-law quantization error', () => {
		for (const s of [-32000, -12345, -100, 0, 100, 500, 12345, 32000]) {
			const back = mulawToLinear(linearToMulaw(s));
			// mu-law is logarithmic: error grows with amplitude, ~3% of |sample| + a floor
			expect(Math.abs(back - s)).toBeLessThanOrEqual(Math.abs(s) * 0.04 + 8);
		}
	});

	// The independent oracle the red-team asked for. Round-trip tests only prove
	// the codec inverts ITSELF — a non-standard but internally-consistent curve
	// would pass them. This pins every one of the 256 bytes to ffmpeg's G.711
	// mu-law decoder (`ffmpeg -f mulaw`), so only the real standard passes.
	// Provenance: g711-oracle.json generated 2026-07-15 by decoding bytes
	// 0x00..0xFF through ffmpeg; regenerate the same way if ever questioned.
	it('decodes every byte exactly as ffmpeg G.711 does (external oracle)', () => {
		expect(g711Oracle).toHaveLength(256);
		for (let b = 0; b < 256; b++) {
			expect(mulawToLinear(b)).toBe(g711Oracle[b]);
		}
	});

	it('encodes each canonical G.711 level back to a byte that decodes to it', () => {
		for (let b = 0; b < 256; b++) {
			const level = g711Oracle[b] as number;
			expect(mulawToLinear(linearToMulaw(level))).toBe(level);
		}
	});

	it('preserves sign', () => {
		expect(mulawToLinear(linearToMulaw(5000))).toBeGreaterThan(0);
		expect(mulawToLinear(linearToMulaw(-5000))).toBeLessThan(0);
	});
});

describe('buffers and tones', () => {
	it('encodes and decodes whole buffers symmetrically', () => {
		const pcm = new Int16Array([0, 1000, -1000, 30000, -30000]);
		const decoded = decodeMulaw(encodePcm(pcm));
		expect(decoded.length).toBe(pcm.length);
	});

	it('generates a tone with the right length and audible energy', () => {
		const t = tone(440, 300);
		expect(t.length).toBe(2400); // 300ms at 8kHz
		const voiced = t.filter((b) => b !== MULAW_SILENCE).length;
		expect(voiced).toBeGreaterThan(t.length / 2);
	});
});

describe('toneStrength — the echo discriminator', () => {
	it('responds strongly to its own frequency and weakly to another', () => {
		const t440 = tone(440, 200);
		const atMatch = toneStrength(t440, 440);
		const atOther = toneStrength(t440, 1000);
		expect(atMatch).toBeGreaterThan(0.1);
		// The loopback's whole echo defense: a 440Hz burst must NOT read as the
		// 600Hz tone the other leg is waiting for. Wide margin, not marginal.
		expect(atMatch).toBeGreaterThan(atOther * 10);
	});

	it('distinguishes the three loopback tones from each other', () => {
		for (const [freq, others] of [
			[440, [600, 1000]],
			[600, [440, 1000]],
			[1000, [440, 600]],
		] as const) {
			const t = tone(freq, 200);
			const self = toneStrength(t, freq);
			for (const o of others) {
				expect(self).toBeGreaterThan(toneStrength(t, o) * 5);
			}
		}
	});

	it('reads near-zero on silence and never throws on an empty frame', () => {
		expect(toneStrength(new Uint8Array(160).fill(MULAW_SILENCE), 440)).toBeLessThan(0.01);
		expect(toneStrength(new Uint8Array(0), 440)).toBe(0);
	});
});
