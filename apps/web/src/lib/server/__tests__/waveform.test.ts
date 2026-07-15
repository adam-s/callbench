/**
 * Waveform-peaks tests — the server-side envelope drawn from the frozen audio.
 * Offline: reads the committed fixture WAV. Pins that the parser handles the
 * PCM16 mono shape the generator writes, that peaks are bounded and the right
 * count, and that an unmeasured format REFUSES rather than returning a wrong
 * (silent-zero) picture.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parsePcm16Wav, peaksFromWav } from '../waveform.ts';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(here, '../../../../fixtures/runs/windshield-quote');

function aFixtureWav(): Buffer {
	const runId = readdirSync(FIXTURES)[0]!;
	return readFileSync(join(FIXTURES, runId, 'call.wav'));
}

describe('parsePcm16Wav', () => {
	it('parses the committed fixture WAV (PCM16 mono)', () => {
		const { samples, sampleRate, channels } = parsePcm16Wav(aFixtureWav());
		expect(channels).toBe(1);
		expect(sampleRate).toBe(8000);
		expect(samples.length).toBeGreaterThan(1000);
	});

	it('refuses a non-WAV buffer rather than guessing', () => {
		expect(() => parsePcm16Wav(Buffer.from('not audio at all, really'))).toThrow(/not a WAV/);
	});

	it('refuses a valid-RIFF WAV that is NOT PCM16 (e.g. IEEE float) — a re-probe, not a wrong picture', () => {
		// Minimal RIFF/WAVE with a fmt chunk declaring IEEE float (format 3, 32-bit)
		// and an empty data chunk. The header is well-formed; the format is one we
		// have not measured, so it must throw rather than silently mis-decode.
		const buf = Buffer.alloc(44);
		buf.write('RIFF', 0, 'ascii');
		buf.writeUInt32LE(36, 4);
		buf.write('WAVE', 8, 'ascii');
		buf.write('fmt ', 12, 'ascii');
		buf.writeUInt32LE(16, 16);
		buf.writeUInt16LE(3, 20); // IEEE float, not PCM
		buf.writeUInt16LE(1, 22); // mono
		buf.writeUInt32LE(8000, 24);
		buf.writeUInt32LE(32000, 28);
		buf.writeUInt16LE(4, 32);
		buf.writeUInt16LE(32, 34); // 32-bit
		buf.write('data', 36, 'ascii');
		buf.writeUInt32LE(0, 40);
		expect(() => parsePcm16Wav(buf)).toThrow(/unsupported WAV/);
	});
});

describe('peaksFromWav', () => {
	it('returns exactly the requested column count, each a [min,max] in [-1,1]', () => {
		const peaks = peaksFromWav(aFixtureWav(), 300);
		expect(peaks).toHaveLength(300);
		for (const [min, max] of peaks) {
			expect(min).toBeLessThanOrEqual(max);
			expect(min).toBeGreaterThanOrEqual(-1);
			expect(max).toBeLessThanOrEqual(1);
		}
	});

	it('has real signal (not all-zero) somewhere — the fixture actually has audio', () => {
		const peaks = peaksFromWav(aFixtureWav(), 200);
		const anyLoud = peaks.some(([min, max]) => max - min > 0.05);
		expect(anyLoud).toBe(true);
	});
});
