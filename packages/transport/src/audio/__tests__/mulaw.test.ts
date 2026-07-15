/**
 * μ-law codec tests. The anchor values are the G.711 facts the wire capture
 * already established from the other side: 0xFF is digital silence (decodes
 * to ~0), and encoding near-zero produces 0xFF — so our encoder's silence is
 * byte-identical to the silence Twilio actually sent us.
 */

import { describe, expect, it } from 'vitest';
import { MULAW_SILENCE } from '../../twilio/frames.ts';
import { decodeMulaw, encodePcm, linearToMulaw, mulawToLinear, tone } from '../mulaw.ts';

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
