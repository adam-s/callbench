/**
 * The speech-to-text seam. One contract; adapters differ only in how they
 * reach a provider and map its response. The core never learns which STT
 * produced a turn — identity travels on the turn's `provider` field.
 *
 * STT is the OFFLINE authoritative pass (docs/models.md § latency split): it
 * runs over a frozen recording, so the contract is batch — bytes in, turns
 * out. Live turn-taking is a separate, local concern and is not this seam.
 */

import type { Confidence } from '@callbench/transcript';

/** A transcribed span, provider-neutral. `startMs`/`endMs` are relative to the
 * start of the audio handed in; the caller offsets them onto the session clock
 * when it builds transcript turns (one clock, one layer stays the caller's
 * job — the STT provider has no session clock). */
export interface SttSpan {
	readonly text: string;
	readonly startMs: number;
	readonly endMs: number;
	readonly confidence: Confidence;
}

export interface SttResult {
	/** Full transcript text, spans joined. */
	readonly text: string;
	readonly spans: readonly SttSpan[];
	/** e.g. `faster-whisper:large-v3` — travels onto every turn built from this. */
	readonly provider: string;
	/** Detected language (BCP-47-ish, e.g. `en`), or null if the provider does
	 * not report one. Language detection is common but not universal. */
	readonly language: string | null;
	/** The model's confidence in the language detection, 0..1, or null if the
	 * provider does not report it — not every STT gives this. */
	readonly languageProbability: number | null;
}

export interface SttProvider {
	/** Transcribe one audio buffer. `mediaType` is the buffer's MIME type
	 * (e.g. `audio/wav`). Batch: the whole recording is present. */
	transcribe(audio: Uint8Array, mediaType: string): Promise<SttResult>;
}
