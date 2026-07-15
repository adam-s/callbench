/**
 * G.711 μ-law ↔ 16-bit linear PCM, plus a tone generator for loopback runs.
 *
 * The wire speaks 8kHz μ-law (measured; see twilio/frames.ts). Anything the
 * bench synthesizes — TTS output, calibration tones — has to pass through
 * this encoder to become frames, so it lives with the transport rather than
 * with any one speech provider.
 *
 * Standard G.711: bias 0x84, clip 32635, result complemented. 0xFF encodes
 * near-zero — which is why an all-0xFF frame is digital silence.
 */

const BIAS = 0x84;
const CLIP = 32635;

export function linearToMulaw(sample: number): number {
	let s = Math.max(-CLIP, Math.min(CLIP, Math.round(sample)));
	const sign = s < 0 ? 0x80 : 0;
	if (s < 0) s = -s;
	s += BIAS;
	let exponent = 7;
	for (let mask = 0x4000; (s & mask) === 0 && exponent > 0; mask >>= 1) exponent--;
	const mantissa = (s >> (exponent + 3)) & 0x0f;
	return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

export function mulawToLinear(byte: number): number {
	const u = ~byte & 0xff;
	const sign = u & 0x80;
	const exponent = (u >> 4) & 0x07;
	const mantissa = u & 0x0f;
	let sample = ((mantissa << 3) + BIAS) << exponent;
	sample -= BIAS;
	return sign ? -sample : sample;
}

/** Encode a PCM buffer (16-bit samples) to μ-law bytes. */
export function encodePcm(samples: Int16Array): Uint8Array {
	const out = new Uint8Array(samples.length);
	for (let i = 0; i < samples.length; i++) out[i] = linearToMulaw(samples[i] as number);
	return out;
}

/** Decode μ-law bytes to 16-bit PCM. */
export function decodeMulaw(bytes: Uint8Array): Int16Array {
	const out = new Int16Array(bytes.length);
	for (let i = 0; i < bytes.length; i++) out[i] = mulawToLinear(bytes[i] as number);
	return out;
}

/** A sine tone as μ-law bytes at 8kHz — the loopback run's voice. */
export function tone(frequencyHz: number, durationMs: number, amplitude = 0.5): Uint8Array {
	const sampleRate = 8000;
	const n = Math.round((durationMs / 1000) * sampleRate);
	const samples = new Int16Array(n);
	for (let i = 0; i < n; i++) {
		samples[i] = Math.round(
			amplitude * 32000 * Math.sin((2 * Math.PI * frequencyHz * i) / sampleRate),
		);
	}
	return encodePcm(samples);
}
