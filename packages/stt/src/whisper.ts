/**
 * faster-whisper adapter — maps the Modal STT endpoint's response to the STT
 * contract. Split in two on purpose:
 *
 *   - `mapWhisperResponse` is a PURE function over the response shape. All the
 *     behavior (confidence extraction, the abstain foundation, span mapping)
 *     lives here and is tested offline against a fixture captured from the real
 *     endpoint. This is where a bug would hide, so this is what the suite pins.
 *   - `ModalWhisperStt` is thin network glue: POST audio, parse JSON, map. It
 *     is exercised live, not in the suite — the suite never touches the network
 *     (AGENTS.md), same discipline as the transport's serve.ts.
 *
 * The endpoint returns OpenAI `verbose_json` PLUS raw confidence fields
 * (avg_logprob, no_speech_prob, per-word probability). We read the superset;
 * a plain OpenAI client would read only `.text`.
 */

import type { Confidence } from '@callbench/transcript';
import type { SttProvider, SttResult, SttSpan } from './contract.ts';

/** The endpoint's response shape (infra/modal/stt.py). Only the fields we
 * read; extra fields are ignored. */
export interface WhisperResponse {
	readonly text: string;
	readonly language: string;
	readonly language_probability: number;
	readonly provider: string;
	readonly segments: ReadonlyArray<{
		readonly start: number;
		readonly end: number;
		readonly text: string;
		readonly avg_logprob: number;
		readonly no_speech_prob: number;
		readonly words: ReadonlyArray<{ readonly probability: number }>;
	}>;
}

function segmentConfidence(seg: WhisperResponse['segments'][number]): Confidence {
	// The weakest word is the turn's weakest link — a single mangled word (a
	// digit string, a name) is exactly the case INCONCLUSIVE must be able to
	// catch, and an average would smooth it away. Empty word list (rare) falls
	// back to the segment's own probability floor: not confident by default.
	const minWordProb = seg.words.length > 0 ? Math.min(...seg.words.map((w) => w.probability)) : 0;
	// The neutral score IS the weakest word's probability (already 0..1). The
	// whisper-specific numbers ride along in `raw` for a human, never for
	// branching — a Deepgram adapter will fill `raw` with its own keys.
	return {
		score: minWordProb,
		raw: { avgLogprob: seg.avg_logprob, noSpeechProb: seg.no_speech_prob, minWordProb },
	};
}

/** Pure: endpoint response → contract result. The tested surface. */
export function mapWhisperResponse(res: WhisperResponse): SttResult {
	const spans: SttSpan[] = res.segments.map((seg) => ({
		text: seg.text.trim(),
		startMs: Math.round(seg.start * 1000),
		endMs: Math.round(seg.end * 1000),
		confidence: segmentConfidence(seg),
	}));
	return {
		text: res.text,
		spans,
		provider: res.provider,
		language: res.language,
		languageProbability: res.language_probability,
	};
}

/** Live adapter. `baseUrl` is the Modal STT endpoint (no trailing slash);
 * `apiKey` is sent as a bearer token when the endpoint requires one. */
/** A shape check at the network seam. The response feeds the FROZEN, hashed
 * record, so endpoint drift (a renamed field, a stock OpenAI endpoint without
 * `provider`/per-segment `words`) must fail LOUDLY here — never freeze
 * `undefined` into permanent evidence. Cheap structural check, not a full
 * schema: enough to catch drift before it reaches the transcript. */
function assertWhisperShape(x: unknown): asserts x is WhisperResponse {
	const r = x as Record<string, unknown>;
	if (
		typeof r?.text !== 'string' ||
		typeof r?.provider !== 'string' ||
		!Array.isArray(r?.segments)
	) {
		throw new Error(
			'STT response is not the expected whisper shape (missing text/provider/segments) — ' +
				'the endpoint drifted or is not the callbench STT endpoint; refusing to freeze it',
		);
	}
	for (const seg of r.segments as Array<Record<string, unknown>>) {
		if (typeof seg?.avg_logprob !== 'number' || !Array.isArray(seg?.words)) {
			throw new Error(
				'STT segment is missing confidence fields (avg_logprob/words) — endpoint drift; refusing to freeze',
			);
		}
	}
}

export class ModalWhisperStt implements SttProvider {
	readonly #baseUrl: string;
	readonly #apiKey: string | undefined;
	readonly #timeoutMs: number;

	/** `timeoutMs` bounds the whole request — a run is bounded before it starts
	 * (AGENTS.md), including a wedged or slow-trickling endpoint. Default is
	 * generous for a long recording; a caller can size it to audio duration. */
	constructor(baseUrl: string, apiKey?: string, timeoutMs = 120_000) {
		this.#baseUrl = baseUrl.replace(/\/$/, '');
		this.#apiKey = apiKey;
		this.#timeoutMs = timeoutMs;
	}

	async transcribe(audio: Uint8Array, mediaType: string): Promise<SttResult> {
		const form = new FormData();
		// Copy into a concrete ArrayBuffer: a Uint8Array's backing buffer types as
		// ArrayBuffer | SharedArrayBuffer, and Blob wants a plain ArrayBuffer.
		const ab = new ArrayBuffer(audio.byteLength);
		new Uint8Array(ab).set(audio);
		form.append('file', new Blob([ab], { type: mediaType }), 'audio');
		const res = await fetch(`${this.#baseUrl}/v1/audio/transcriptions`, {
			method: 'POST',
			headers: this.#apiKey ? { authorization: `Bearer ${this.#apiKey}` } : {},
			body: form,
			signal: AbortSignal.timeout(this.#timeoutMs),
		});
		if (!res.ok) {
			throw new Error(
				`STT endpoint ${this.#baseUrl} returned HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`,
			);
		}
		const json: unknown = await res.json();
		assertWhisperShape(json);
		return mapWhisperResponse(json);
	}
}
