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

/** Deterministic xorshift32 — reproducible noise without an RNG dependency;
 * the same seed always renders the same take (a flaky fixture tests nothing). */
function xorshift32(seed: number): () => number {
	let s = seed >>> 0 || 1;
	return () => {
		s ^= s << 13;
		s ^= s >>> 17;
		s ^= s << 5;
		s >>>= 0;
		return s / 0xffffffff;
	};
}

/**
 * Additive babble-ish noise at a target SNR against the stage's own running
 * speech level. True babble is recorded crowd speech; this synthesizes a
 * speech-SHAPED stand-in (several detuned low-frequency oscillators with
 * amplitude wobble, band-passed by construction) — non-stationary the way the
 * literature says matters, and fully reproducible from the committed seed.
 * SNR is tracked against a slow EMA of frame RMS so the noise follows the
 * voice level instead of a guessed constant.
 */
export function babble(snrDb: number, seed = 0x5eed): FrameStage {
	const rand = xorshift32(seed);
	const oscs = Array.from({ length: 6 }, () => ({
		freq: 120 + rand() * 800,
		phase: rand() * Math.PI * 2,
		wobble: 0.3 + rand() * 0.7,
		wobblePhase: rand() * Math.PI * 2,
	}));
	let t = 0;
	let speechRmsEma = 2000;
	const snrLin = 10 ** (snrDb / 20);
	return {
		name: `babble(${snrDb}dB,seed=${seed})`,
		process(frame) {
			let sum = 0;
			for (const s of frame) sum += s * s;
			const rms = Math.sqrt(sum / Math.max(1, frame.length));
			if (rms > 500) speechRmsEma = 0.95 * speechRmsEma + 0.05 * rms;
			const noiseRms = speechRmsEma / snrLin;
			const out = new Int16Array(frame.length);
			for (let i = 0; i < frame.length; i++) {
				let n = 0;
				for (const o of oscs) {
					const wob = 0.5 + 0.5 * Math.sin(o.wobblePhase + (t / 8000) * 2 * Math.PI * o.wobble);
					n += wob * Math.sin(o.phase + (t / 8000) * 2 * Math.PI * o.freq);
				}
				// Normalize by the ensemble's actual RMS, not its count: each term is
				// wob*sin with E[(wob*sin)^2] = 0.375 * 0.5, so the 6-osc sum has rms
				// sqrt(6 * 0.1875) ≈ 1.06 — dividing by 6 shipped noise ~13dB quiet
				// (measured 24.9dB at a 12dB target; the test caught it).
				n = (n / 1.06) * noiseRms;
				out[i] = clamp((frame[i] ?? 0) + n);
				t++;
			}
			return out;
		},
		reset() {
			t = 0;
			speechRmsEma = 2000;
		},
	};
}

/** Crude band-limit: one-pole high-pass at `lowHz` + one-pole low-pass at
 * `highHz` — the "cheap handset" squeeze inside the already-narrow phone band. */
export function bandLimit(lowHz: number, highHz: number, rate = 8000): FrameStage {
	const aHp = Math.exp((-2 * Math.PI * lowHz) / rate);
	const aLp = 1 - Math.exp((-2 * Math.PI * highHz) / rate);
	let hx = 0;
	let hy = 0;
	let ly1 = 0;
	let ly2 = 0;
	return {
		name: `bandLimit(${lowHz}-${highHz}Hz)`,
		process(frame) {
			const out = new Int16Array(frame.length);
			for (let i = 0; i < frame.length; i++) {
				const x = frame[i] ?? 0;
				hy = aHp * (hy + x - hx);
				hx = x;
				// TWO cascaded low-pass poles (12dB/oct): a single EMA pole this
				// close to Nyquist is so shallow that the high-pass's collateral
				// attenuation of in-band content outweighed it — the filter cut
				// 1kHz harder than 3.7kHz (the test caught it).
				ly1 += aLp * (hy - ly1);
				ly2 += aLp * (ly1 - ly2);
				out[i] = clamp(ly2);
			}
			return out;
		},
		reset() {
			hx = 0;
			hy = 0;
			ly1 = 0;
			ly2 = 0;
		},
	};
}

/**
 * Frame erasure on the Gilbert-Elliott two-state model (ITU-T G.191's shape):
 * bursty, the way real transport loss arrives — iid loss under-models it.
 * `lossProb` is the long-run loss rate; `burstiness` (0..1) is the chance a
 * lost frame is followed by another. Concealment mimics what a receiver
 * actually does: 'repeat' plays the last good frame, 'silence' plays zeros.
 */
export function frameErase(
	lossProb: number,
	burstiness = 0.5,
	conceal: 'repeat' | 'silence' = 'repeat',
	seed = 0xe4a5e,
): FrameStage {
	const rand = xorshift32(seed);
	// Derive the two-state transition probabilities from loss rate + burstiness.
	const pBadToBad = burstiness;
	const pGoodToBad = (lossProb * (1 - pBadToBad)) / Math.max(0.01, 1 - lossProb);
	let bad = false;
	let last: Int16Array | null = null;
	return {
		name: `frameErase(${(lossProb * 100).toFixed(0)}%,burst=${burstiness},${conceal})`,
		process(frame) {
			bad = bad ? rand() < pBadToBad : rand() < pGoodToBad;
			if (!bad) {
				last = frame;
				return frame;
			}
			if (conceal === 'repeat' && last) return last;
			return new Int16Array(frame.length);
		},
		reset() {
			bad = false;
			last = null;
		},
	};
}
