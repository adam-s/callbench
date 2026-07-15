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
	return {
		avgLogprob: seg.avg_logprob,
		noSpeechProb: seg.no_speech_prob,
		minWordProb,
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
export class ModalWhisperStt implements SttProvider {
	readonly #baseUrl: string;
	readonly #apiKey: string | undefined;

	constructor(baseUrl: string, apiKey?: string) {
		this.#baseUrl = baseUrl.replace(/\/$/, '');
		this.#apiKey = apiKey;
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
		});
		if (!res.ok) {
			throw new Error(
				`STT endpoint ${this.#baseUrl} returned HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`,
			);
		}
		return mapWhisperResponse((await res.json()) as WhisperResponse);
	}
}
