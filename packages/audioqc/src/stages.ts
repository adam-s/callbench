/**
 * Modular streaming sound processing — small stateful stages over PCM16
 * frames, composable into a chain the caller can insert anywhere audio flows
 * (before TTS hits the wire, before a capture hits STT, over a frozen take).
 *
 * Design rules, both load-bearing:
 *   - A stage is STREAMING: it sees one frame at a time, carries its own
 *     state, and never buffers unbounded — so the same chain runs identically
 *     over a live 20ms path and a frozen file.
 *   - A stage is a REMEDY, and a remedy reaches past its target (AGENTS.md):
 *     nothing here is wired into a default path. A stage earns its place by
 *     an A/B — process a take, run the metrics (metrics.ts), and listen —
 *     against the unprocessed reference. Until then, chains are equipment for
 *     experiments, not plumbing.
 */

export interface FrameStage {
	readonly name: string;
	/** Process one frame in place-or-copy; returns the frame to pass on. */
	process(frame: Int16Array): Int16Array;
	/** Drop internal state (new utterance / new take). */
	reset(): void;
}

const clamp = (v: number): number => Math.max(-32768, Math.min(32767, Math.round(v)));

/** Fixed linear gain. `db` may be negative. */
export function gain(db: number): FrameStage {
	const factor = 10 ** (db / 20);
	return {
		name: `gain(${db}dB)`,
		process(frame) {
			const out = new Int16Array(frame.length);
			for (let i = 0; i < frame.length; i++) out[i] = clamp((frame[i] ?? 0) * factor);
			return out;
		},
		reset() {},
	};
}

/** One-pole DC blocker (high-pass ~20Hz at 8kHz): removes the constant offset
 * a bad capture path adds, which wastes headroom and thumps on playback. */
export function dcBlock(): FrameStage {
	let x1 = 0;
	let y1 = 0;
	const R = 0.995;
	return {
		name: 'dcBlock',
		process(frame) {
			const out = new Int16Array(frame.length);
			for (let i = 0; i < frame.length; i++) {
				const x = frame[i] ?? 0;
				const y = x - x1 + R * y1;
				x1 = x;
				y1 = y;
				out[i] = clamp(y);
			}
			return out;
		},
		reset() {
			x1 = 0;
			y1 = 0;
		},
	};
}

/** Soft limiter: tanh knee above `kneeFs` of full scale. Rounds off the harsh
 * edge of near-clipping audio without the flat-top distortion of hard clip. */
export function softLimit(kneeFs = 0.8): FrameStage {
	const knee = 32768 * kneeFs;
	return {
		name: `softLimit(${kneeFs})`,
		process(frame) {
			const out = new Int16Array(frame.length);
			for (let i = 0; i < frame.length; i++) {
				const x = frame[i] ?? 0;
				const a = Math.abs(x);
				out[i] =
					a <= knee
						? x
						: clamp(
								Math.sign(x) * (knee + (32768 - knee) * Math.tanh((a - knee) / (32768 - knee))),
							);
			}
			return out;
		},
		reset() {},
	};
}

/** Downward noise gate with hysteresis and linear release: attenuates frames
 * whose energy sits below `openRms`, easing over `releaseFrames` so the gate
 * never clicks. For hiss BETWEEN words; it must never chop word tails — hence
 * the generous default release. */
export function noiseGate(openRms = 150, floorDb = -18, releaseFrames = 10): FrameStage {
	const floorGain = 10 ** (floorDb / 20);
	let level = 1; // current gain, eased toward open (1) or floor
	return {
		name: `noiseGate(${openRms},${floorDb}dB)`,
		process(frame) {
			let sum = 0;
			for (const s of frame) sum += Math.abs(s);
			const mean = sum / Math.max(1, frame.length);
			const target = mean >= openRms ? 1 : floorGain;
			// Open fast (speech must never be clipped), release slow.
			level = target > level ? target : Math.max(target, level - (1 - floorGain) / releaseFrames);
			const out = new Int16Array(frame.length);
			for (let i = 0; i < frame.length; i++) out[i] = clamp((frame[i] ?? 0) * level);
			return out;
		},
		reset() {
			level = 1;
		},
	};
}

/** Compose stages left→right into one. */
export function chain(...stages: FrameStage[]): FrameStage {
	return {
		name: stages.map((s) => s.name).join(' → '),
		process(frame) {
			let f = frame;
			for (const s of stages) f = s.process(f);
			return f;
		},
		reset() {
			for (const s of stages) s.reset();
		},
	};
}

/** Run a chain over a whole PCM buffer in 20ms frames — the offline harness
 * for A/B experiments: process a take, re-measure, listen. */
export function processBuffer(pcm: Int16Array, stage: FrameStage, frameLen = 160): Int16Array {
	stage.reset();
	const out = new Int16Array(pcm.length);
	for (let i = 0; i < pcm.length; i += frameLen) {
		const frame = pcm.subarray(i, Math.min(i + frameLen, pcm.length));
		out.set(stage.process(new Int16Array(frame)), i);
	}
	return out;
}
