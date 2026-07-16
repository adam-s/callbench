/**
 * Audio-quality metrics — how the bench TELLS whether audio is clean, as
 * numbers instead of an ear. No-reference, deterministic, pure: PCM in,
 * figures out. The thresholds that turn a figure into a flag are ADVISORY —
 * a flag means "listen here", never "defective"; the deciding instrument for
 * anything outward-facing stays a human ear on the flagged span.
 *
 * Why level-normalized clicks: an absolute slew threshold mistakes a hot
 * recording for a broken one — on 2026-07-16 it ranked Twilio's (clean,
 * louder) wire recording 400× worse than a quieter capture of the same call.
 * Every click here is relative to its own 20ms window's RMS.
 */

import { goertzelFraction } from '@callbench/shared';

export interface WavChannel {
	readonly label: string;
	readonly pcm: Int16Array;
	readonly sampleRate: number;
}

/** Parse a PCM16 WAV (mono or multi-channel) into per-channel PCM. Pure —
 * bytes in, channels out; the caller owns file I/O. */
export function readWavChannels(raw: Uint8Array): WavChannel[] {
	const buf = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
	if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
		throw new Error('not a RIFF/WAVE file');
	}
	let pos = 12;
	let channels = 1;
	let sampleRate = 8000;
	let bits = 16;
	let data: Buffer | null = null;
	while (pos + 8 <= buf.length) {
		const id = buf.toString('ascii', pos, pos + 4);
		const size = buf.readUInt32LE(pos + 4);
		if (id === 'fmt ') {
			channels = buf.readUInt16LE(pos + 10);
			sampleRate = buf.readUInt32LE(pos + 12);
			bits = buf.readUInt16LE(pos + 22);
		} else if (id === 'data') {
			data = buf.subarray(pos + 8, pos + 8 + size);
		}
		pos += 8 + size + (size % 2);
	}
	if (!data) throw new Error('no data chunk');
	if (bits !== 16) throw new Error(`${bits}-bit audio; only PCM16 supported`);
	const frames = Math.floor(data.length / 2 / channels);
	const out: WavChannel[] = [];
	for (let c = 0; c < channels; c++) {
		const pcm = new Int16Array(frames);
		for (let i = 0; i < frames; i++) pcm[i] = data.readInt16LE((i * channels + c) * 2);
		out.push({ label: channels === 1 ? 'mono' : `ch${c + 1}`, pcm, sampleRate });
	}
	return out;
}

export interface AudioMetrics {
	readonly durationSec: number;
	readonly speechSec: number;
	readonly speechRms: number;
	readonly speechDbfs: number;
	/** Hiss between words — loudest decile of quiet non-zero windows. */
	readonly noiseFloor: number;
	readonly snrDb: number | null;
	readonly peak: number;
	readonly clippedSamples: number;
	readonly dcOffset: number;
	/** Level-normalized discontinuities per second of speech. */
	readonly clicksPerSec: number;
	/** 40–500ms near-silent gaps bounded by speech — lost frames / starvation. */
	readonly dropoutGaps: number;
	/** Energy fraction at 3.7kHz over the loudest speech — resample artifacts;
	 * a phone channel carries ≈nothing above 3.4kHz. */
	readonly outOfBandFraction: number;
}

/** Mean |PCM| speech gate, same family as the turn detector's energy. */
const SPEECH_RMS = 300;

export function analyzeChannel(ch: WavChannel): AudioMetrics {
	const { pcm, sampleRate } = ch;
	const win = Math.round(sampleRate * 0.02);
	const nWin = Math.floor(pcm.length / win);
	const rms: number[] = [];
	for (let w = 0; w < nWin; w++) {
		let sum = 0;
		for (let i = w * win; i < (w + 1) * win; i++) sum += (pcm[i] ?? 0) ** 2;
		rms.push(Math.sqrt(sum / win));
	}
	const speechWins = rms.map((r, i) => [r, i] as const).filter(([r]) => r > SPEECH_RMS);
	const quiet = rms.filter((r) => r <= SPEECH_RMS && r > 1).sort((a, b) => a - b);
	const noiseFloor = quiet.length > 0 ? (quiet[Math.floor(quiet.length * 0.9)] as number) : 0;
	const speechRms =
		speechWins.length > 0 ? speechWins.reduce((a, [r]) => a + r, 0) / speechWins.length : 0;
	const snrDb = noiseFloor > 0 && speechRms > 0 ? 20 * Math.log10(speechRms / noiseFloor) : null;

	let peak = 0;
	let clippedSamples = 0;
	let dcSum = 0;
	for (const s of pcm) {
		const a = Math.abs(s);
		if (a > peak) peak = a;
		if (a >= 32760) clippedSamples++;
		dcSum += s;
	}

	let clicks = 0;
	for (const [r, w] of speechWins) {
		// 6× the window RMS, CAPPED at 20000: uncapped, a hot window (rms
		// ~5700+) demands a delta larger than PCM16 can physically produce, so
		// the metric goes blind exactly when audio is loud. The cap can in
		// principle false-fire on sustained full-scale ~1kHz content; phone
		// speech does not do that, and a false flag only costs a listen.
		// And from the window's FIRST sample (comparing across the boundary):
		// frame-placement tears land exactly on 20ms boundaries, and a loop
		// starting one sample in is blind to the precise defect this metric
		// exists to catch. The synthetic tests caught both mistakes.
		const threshold = Math.max(2000, Math.min(6 * Math.max(r, 200), 20000));
		for (let i = Math.max(1, w * win); i < Math.min((w + 1) * win, pcm.length); i++) {
			if (Math.abs((pcm[i] ?? 0) - (pcm[i - 1] ?? 0)) > threshold) clicks++;
		}
	}
	const speechSec = speechWins.length * 0.02;

	let dropoutGaps = 0;
	let run = 0;
	let sawSpeech = false;
	for (let w = 0; w < nWin; w++) {
		if ((rms[w] ?? 0) > SPEECH_RMS) {
			if (sawSpeech && run >= 2 && run <= 25) dropoutGaps++;
			run = 0;
			sawSpeech = true;
		} else if ((rms[w] ?? 0) < 20 && sawSpeech) {
			run++;
		} else {
			run = 0;
		}
	}

	const loudest = [...speechWins].sort((a, b) => b[0] - a[0]).slice(0, 5);
	const outOfBandFraction =
		loudest.length > 0
			? loudest.reduce((a, [, w]) => a + goertzelFraction(pcm, w * win, win, 3700, sampleRate), 0) /
				loudest.length
			: 0;

	return {
		durationSec: pcm.length / sampleRate,
		speechSec,
		speechRms,
		speechDbfs: 20 * Math.log10(Math.max(1, speechRms) / 32768),
		noiseFloor,
		snrDb,
		peak,
		clippedSamples,
		dcOffset: dcSum / Math.max(1, pcm.length),
		clicksPerSec: clicks / Math.max(speechSec, 0.1),
		dropoutGaps,
		outOfBandFraction,
	};
}

/** Advisory flags: which metrics deserve an ear. Kept OUT of analyzeChannel so
 * a caller can apply stricter or looser bars without re-measuring. */
export function advisoryFlags(m: AudioMetrics): string[] {
	const flags: string[] = [];
	if (m.snrDb !== null && m.snrDb < 20) flags.push('snr');
	if (m.clippedSamples > 10) flags.push('clipping');
	if (Math.abs(m.dcOffset) > 100) flags.push('dc-offset');
	if (m.clicksPerSec > 5) flags.push('clicks');
	if (m.dropoutGaps > 2) flags.push('dropouts');
	if (m.outOfBandFraction > 0.02) flags.push('out-of-band');
	return flags;
}

export function renderMetrics(m: AudioMetrics, flags = advisoryFlags(m)): string[] {
	const f = (name: string) => (flags.includes(name) ? '  ← CHECK BY EAR' : '');
	return [
		`  speech: ${m.speechSec.toFixed(1)}s of ${m.durationSec.toFixed(1)}s at rms ${m.speechRms.toFixed(0)} (${m.speechDbfs.toFixed(1)} dBFS)`,
		`  noise floor: ${m.noiseFloor.toFixed(0)}  SNR ${m.snrDb === null ? 'n/a' : `${m.snrDb.toFixed(1)} dB`}${f('snr')}`,
		`  peak: ${m.peak} (${((m.peak / 32768) * 100).toFixed(0)}%FS)  clipped: ${m.clippedSamples}${f('clipping')}`,
		`  dc offset: ${m.dcOffset.toFixed(1)}${f('dc-offset')}`,
		`  clicks/sec (level-normalized): ${m.clicksPerSec.toFixed(1)}${f('clicks')}`,
		`  dropout gaps (40–500ms, mid-speech): ${m.dropoutGaps}${f('dropouts')}`,
		`  out-of-band (3.7kHz) fraction: ${(m.outOfBandFraction * 100).toFixed(2)}%${f('out-of-band')}`,
	];
}
