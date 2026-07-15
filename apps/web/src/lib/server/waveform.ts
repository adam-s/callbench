/**
 * Server-side waveform peaks — a min/max envelope of the frozen recording,
 * downsampled to a fixed number of columns for the canvas to draw.
 *
 * Why server-side, when ui.md sketches a client-side AudioContext for the
 * waveform: the dial fence bans outbound `fetch` in client code (a real
 * dial-capable primitive), so the browser must not fetch the audio bytes to
 * decode them. Computing the envelope here honors the same principle ui.md
 * actually cares about — the waveform is a PROPERTY OF THE FILE, measuring
 * nothing about the call — while keeping the fence airtight. The <audio> element
 * still loads the file by `src` for playback (media loading, not a fetch), and
 * the live meter reads the already-loaded element's AnalyserNode; neither
 * fetches, and neither produces a reported figure.
 *
 * This reads the same verified bytes `readRunAudio` returns, so a drifted file is
 * already refused upstream. It handles the PCM16 mono WAV the fixture generator
 * writes; a live capture in another format is a re-probe point (capture the real
 * shape before extending the parser), not a silent zero.
 */

/** One column of the envelope: the min and max sample in that column, in [-1, 1]. */
export type Peak = readonly [min: number, max: number];

interface Pcm16 {
	readonly samples: Int16Array;
	readonly sampleRate: number;
	readonly channels: number;
}

/** Parse a canonical PCM16 WAV (fmt + data chunks). Throws on anything else, so a
 * format we have not measured is a loud re-probe, not a wrong picture. */
export function parsePcm16Wav(bytes: Buffer): Pcm16 {
	if (
		bytes.length < 44 ||
		bytes.toString('ascii', 0, 4) !== 'RIFF' ||
		bytes.toString('ascii', 8, 12) !== 'WAVE'
	) {
		throw new Error('not a WAV file');
	}
	let off = 12;
	let sampleRate = 0;
	let channels = 0;
	let bitsPerSample = 0;
	let dataOff = -1;
	let dataLen = 0;
	while (off + 8 <= bytes.length) {
		const id = bytes.toString('ascii', off, off + 4);
		const size = bytes.readUInt32LE(off + 4);
		if (id === 'fmt ') {
			// A fmt chunk shorter than 16 bytes can't carry the fields we read at
			// fixed offsets — refuse rather than read past it into a RangeError.
			if (size < 16 || off + 8 + 16 > bytes.length) {
				throw new Error('unsupported WAV: truncated fmt chunk');
			}
			const audioFormat = bytes.readUInt16LE(off + 8);
			channels = bytes.readUInt16LE(off + 10);
			sampleRate = bytes.readUInt32LE(off + 12);
			bitsPerSample = bytes.readUInt16LE(off + 22);
			if (audioFormat !== 1 || bitsPerSample !== 16) {
				throw new Error(
					`unsupported WAV: format ${audioFormat}, ${bitsPerSample}-bit (want PCM16)`,
				);
			}
		} else if (id === 'data') {
			dataOff = off + 8;
			dataLen = size;
			break;
		}
		off += 8 + size + (size % 2);
	}
	if (dataOff < 0) throw new Error('no data chunk in WAV');
	if (channels !== 1) throw new Error(`unsupported WAV: ${channels} channels (want mono)`);
	// Clamp to the bytes actually present: a declared data size larger than the
	// file (a truncated or lying header) must not read past the buffer. The reader
	// runs on hash-verified bytes, so this is belt-and-suspenders — a clean refuse
	// beats a RangeError 500.
	const available = Math.max(0, Math.floor((bytes.length - dataOff) / 2));
	const count = Math.min(Math.floor(dataLen / 2), available);
	const samples = new Int16Array(count);
	for (let i = 0; i < count; i++) samples[i] = bytes.readInt16LE(dataOff + i * 2);
	return { samples, sampleRate, channels };
}

/**
 * Downsample PCM16 samples to `columns` min/max pairs in [-1, 1]. A column that
 * spans no samples (a very short clip) is flat zero rather than undefined, so the
 * canvas never has a gap it must guess at.
 */
export function peaksFromWav(bytes: Buffer, columns: number): Peak[] {
	const { samples } = parsePcm16Wav(bytes);
	const n = samples.length;
	const cols = Math.max(1, Math.floor(columns));
	const peaks: Peak[] = [];
	for (let c = 0; c < cols; c++) {
		const start = Math.floor((c / cols) * n);
		const end = Math.max(start + 1, Math.floor(((c + 1) / cols) * n));
		let min = 0;
		let max = 0;
		for (let i = start; i < end && i < n; i++) {
			const v = (samples[i] as number) / 32768;
			if (v < min) min = v;
			if (v > max) max = v;
		}
		peaks.push([min, max]);
	}
	return peaks;
}
