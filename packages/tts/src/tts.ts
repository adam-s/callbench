/**
 * The text-to-speech seam — the bench's voice. One contract; adapters differ
 * only in how they reach a provider. Identity travels on `provider`.
 *
 * A synthesized utterance comes back as 8kHz PCM (the transport's rate) and is
 * framed into mulaw here, reusing the transport's own encodePcm — so the wire
 * format is defined in exactly one place (verified byte-identical to ffmpeg's
 * G.711). Scripted lines are synthesized BEFORE a call and played from the
 * frames (docs/models.md § latency split); the ~455ms link is paid up front.
 */

import { BYTES_PER_FRAME, encodePcm } from '@callbench/transport';

export interface Utterance {
	/** 16-bit PCM samples at `sampleRate`, mono. */
	readonly pcm: Int16Array;
	readonly sampleRate: number;
	/** e.g. `kokoro-82m` — travels onto the bench turn built from this. */
	readonly provider: string;
}

export interface TtsProvider {
	synthesize(text: string, voice?: string): Promise<Utterance>;
}

/**
 * Split a synthesized utterance into transport-ready mulaw frames (160 bytes =
 * 20ms each). The utterance MUST already be at the transport's 8kHz — a wrong
 * rate here would play back at the wrong speed and pitch, so it is checked
 * rather than silently resampled (resampling is the endpoint's job). The final
 * partial frame is padded with mulaw silence so every frame is whole.
 */
export function toMulawFrames(utterance: Utterance, transportRate = 8000): Uint8Array[] {
	if (utterance.sampleRate !== transportRate) {
		throw new Error(
			`utterance is ${utterance.sampleRate}Hz but the transport is ${transportRate}Hz — ` +
				'resample at the endpoint, not here',
		);
	}
	const mulaw = encodePcm(utterance.pcm);
	const frames: Uint8Array[] = [];
	for (let i = 0; i < mulaw.length; i += BYTES_PER_FRAME) {
		const slice = mulaw.subarray(i, i + BYTES_PER_FRAME);
		if (slice.length === BYTES_PER_FRAME) {
			frames.push(slice);
		} else {
			// Pad the tail to a whole 20ms frame with mulaw silence (0xFF).
			const padded = new Uint8Array(BYTES_PER_FRAME).fill(0xff);
			padded.set(slice);
			frames.push(padded);
		}
	}
	return frames;
}

/** Total playback duration of an utterance, in ms — used to stamp the bench
 * turn's endMs on the session clock (startMs + this). */
export function durationMs(utterance: Utterance): number {
	return Math.round((utterance.pcm.length / utterance.sampleRate) * 1000);
}

/** Live adapter for the Modal Kokoro endpoint. `baseUrl` is the TTS endpoint;
 * the /v1/audio/speech route returns raw PCM16LE at the endpoint's out-rate. */
export class ModalKokoroTts implements TtsProvider {
	readonly #baseUrl: string;
	readonly #apiKey: string | undefined;
	readonly #timeoutMs: number;

	/** `timeoutMs` bounds the whole request (AGENTS.md: a run is bounded before
	 * it starts) — a wedged endpoint cannot hang synthesis forever. */
	constructor(baseUrl: string, apiKey?: string, timeoutMs = 60_000) {
		this.#baseUrl = baseUrl.replace(/\/$/, '');
		this.#apiKey = apiKey;
		this.#timeoutMs = timeoutMs;
	}

	async synthesize(text: string, voice?: string): Promise<Utterance> {
		const res = await fetch(`${this.#baseUrl}/v1/audio/speech`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				...(this.#apiKey ? { authorization: `Bearer ${this.#apiKey}` } : {}),
			},
			body: JSON.stringify({ input: text, ...(voice ? { voice } : {}) }),
			signal: AbortSignal.timeout(this.#timeoutMs),
		});
		if (!res.ok) {
			throw new Error(
				`TTS endpoint ${this.#baseUrl} returned HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`,
			);
		}
		const rate = Number(res.headers.get('x-sample-rate') ?? 8000);
		const provider = res.headers.get('x-provider') ?? 'kokoro';
		const buf = new Uint8Array(await res.arrayBuffer());
		// Raw little-endian 16-bit PCM. Read as Int16 over the same bytes.
		const pcm = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 2));
		return { pcm, sampleRate: rate, provider };
	}

	/**
	 * Streaming synthesis: yield each clause's PCM16 the instant the endpoint
	 * flushes it (`/v1/audio/speech/stream`, HTTP chunked). The caller pushes
	 * each chunk to the frame pacer, so the wire plays clause one while the
	 * endpoint is still synthesizing clause two — first-audio tracks one clause
	 * (tens of ms warm) instead of the whole utterance (1–3s).
	 *
	 * The response body is a raw PCM16 LE byte stream with NO framing of its
	 * own, so a chunk can split mid-sample; a one-byte remainder is carried to
	 * the next chunk. Each yielded `PcmChunk` is whole samples.
	 */
	async *synthesizeStream(text: string, voice?: string): AsyncGenerator<PcmChunk> {
		const res = await fetch(`${this.#baseUrl}/v1/audio/speech/stream`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				...(this.#apiKey ? { authorization: `Bearer ${this.#apiKey}` } : {}),
			},
			body: JSON.stringify({ input: text, ...(voice ? { voice } : {}) }),
			signal: AbortSignal.timeout(this.#timeoutMs),
		});
		if (!res.ok || !res.body) {
			throw new Error(
				`TTS stream endpoint ${this.#baseUrl} returned HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`,
			);
		}
		const rate = Number(res.headers.get('x-sample-rate') ?? 8000);
		const provider = res.headers.get('x-provider') ?? 'kokoro-stream';
		let carry = new Uint8Array(0);
		for await (const part of res.body as unknown as AsyncIterable<Uint8Array>) {
			const merged = new Uint8Array(carry.length + part.length);
			merged.set(carry);
			merged.set(part, carry.length);
			const whole = merged.length - (merged.length % 2);
			if (whole > 0) {
				const pcm = new Int16Array(merged.buffer, merged.byteOffset, whole / 2);
				yield { pcm: pcm.slice(), sampleRate: rate, provider };
			}
			carry = merged.subarray(whole);
		}
	}
}

/** One streamed slice of an utterance — whole PCM16 samples at `sampleRate`. */
export interface PcmChunk {
	readonly pcm: Int16Array;
	readonly sampleRate: number;
	readonly provider: string;
}
