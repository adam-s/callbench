/**
 * The whisper mapping is tested against a response CAPTURED FROM THE REAL
 * endpoint (fixtures/whisper-response.json — a live transcription of an 8kHz
 * telephony-rate phrase, 2026-07-15). A hand-authored fixture would risk
 * getting the confidence-field shapes wrong; this one can't, because the
 * endpoint produced it.
 *
 * What's pinned here is the load-bearing part: the confidence signal that
 * INCONCLUSIVE will be built on. The network POST is not tested — it is thin
 * glue and the suite never dials.
 */

import { describe, expect, it } from 'vitest';
import { mapWhisperResponse, type WhisperResponse } from '../whisper.ts';
import fixture from './fixtures/whisper-response.json' with { type: 'json' };

const res = fixture as WhisperResponse;

describe('mapWhisperResponse against the real capture', () => {
	it('carries the full text and the provider tag', () => {
		const r = mapWhisperResponse(res);
		expect(r.text).toContain('windshield');
		expect(r.provider).toBe('faster-whisper:large-v3');
		expect(r.language).toBe('en');
	});

	it('maps every segment to a span with ms timings', () => {
		const r = mapWhisperResponse(res);
		expect(r.spans).toHaveLength(res.segments.length);
		for (const s of r.spans) {
			expect(Number.isInteger(s.startMs)).toBe(true);
			expect(s.endMs).toBeGreaterThanOrEqual(s.startMs);
		}
	});

	it('score is the WEAKEST word probability — not an average; raw keeps the detail', () => {
		const r = mapWhisperResponse(res);
		for (let i = 0; i < r.spans.length; i++) {
			const span = r.spans[i];
			const seg = res.segments[i];
			if (!span || !seg) throw new Error('missing span/segment');
			// raw carries the provider's own numbers verbatim (forensics only).
			expect(span.confidence.raw.avgLogprob).toBe(seg.avg_logprob);
			expect(span.confidence.raw.noSpeechProb).toBe(seg.no_speech_prob);
			// The neutral score is the weakest word — the abstain signal.
			const expectedMin = Math.min(...seg.words.map((w) => w.probability));
			expect(span.confidence.score).toBe(expectedMin);
			for (const w of seg.words) {
				expect(span.confidence.score).toBeLessThanOrEqual(w.probability);
			}
		}
	});

	it('surfaces a genuinely low-confidence word (the abstain signal is real)', () => {
		// The captured phrase contains the invented word "Callbench", which the
		// model heard poorly — this fixture exists partly to prove the signal is
		// not always ~1.0. Some span's score is clearly uncertain.
		const r = mapWhisperResponse(res);
		const weakest = Math.min(...r.spans.map((s) => s.confidence.score));
		expect(weakest).toBeLessThan(0.8);
	});

	it('does not crash on an empty word list, and defaults to not-confident', () => {
		const noWords: WhisperResponse = {
			...res,
			segments: [{ ...res.segments[0]!, words: [] }],
		};
		expect(mapWhisperResponse(noWords).spans[0]?.confidence.score).toBe(0);
	});
});
