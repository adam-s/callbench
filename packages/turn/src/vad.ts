/**
 * Turn-taking: deciding when the far end has stopped speaking, so the bench
 * knows when to reply. This runs in the LIVE 20ms path (docs/models.md), so it
 * is local and cheap — it never crosses the network.
 *
 * This is an ENERGY VAD with a TWO-STAGE, CANCELLABLE endpoint. The first
 * shipped version used a single hangover and set a terminal flag the instant
 * silence elapsed — so speech resuming after a natural mid-sentence pause
 * could never re-attach, and a live take split "It's a 2015 [pause] Audi A3"
 * into two turns and desynced the whole exchange (observed 2026-07-16, take
 * bf519398). Production stacks keep the endpoint PROVISIONAL: pipecat's VAD
 * returns from its STOPPING state to SPEAKING when speech resumes, and
 * Deepgram Flux emits TurnResumed to cancel a speculative end-of-turn. This
 * detector does the same with plain energy:
 *
 *   speech … silence ≥ provisionalSilenceMs → 'turn-maybe-end' (advisory)
 *   … speech resumes before confirmSilenceMs → the turn RE-ATTACHES, no end
 *   … silence reaches confirmSilenceMs      → 'turn-end' (the real signal)
 *
 * A turn additionally needs minSpeechMs of accumulated speech before any end
 * may fire — a stray energy blip must not open and close a phantom turn.
 *
 * The named limitation stands, narrowed: a silence LONGER than the confirm
 * window still cannot be told from "finished". References.md's smart-turn
 * (v3: 8MB int8 ONNX, ~12ms CPU) reads the waveform semantically and is the
 * upgrade path — behind this same `TurnDetector` shape, with the 8→16kHz
 * resample its feature extractor hardcodes (verified against pipecat source).
 */

import { decodeMulaw } from '@callbench/transport';

export interface TurnDetectorConfig {
	/** Mean |PCM| above this counts a frame as speech. The PSTN noise floor
	 * sits well below a real voice; tune against captured audio, not a guess. */
	readonly speechEnergy: number;
	/** Trailing silence that makes an end-of-turn PLAUSIBLE — the advisory
	 * 'turn-maybe-end'. Production VADs sit at 200–550ms here. */
	readonly provisionalSilenceMs: number;
	/** Trailing silence that CONFIRMS the end. Between provisional and confirm,
	 * resumed speech re-attaches to the same turn — the cancellable window that
	 * keeps a mid-sentence pause from splitting an utterance. Number- and
	 * list-heavy lines pause longest; a scenario may override upward. */
	readonly confirmSilenceMs: number;
	/** Accumulated speech required before ANY end may fire — rejects blips. */
	readonly minSpeechMs: number;
	/** Frame duration (ms). Twilio media frames are 20ms. */
	readonly frameMs: number;
}

export const DEFAULT_TURN_CONFIG: TurnDetectorConfig = {
	speechEnergy: 500,
	provisionalSilenceMs: 300,
	// A/B'd live 900 vs 600 (takes 1784207852425 / 1784208362852, 2026-07-16):
	// 600 was a WASH on perceived gap — the shorter window steals exactly the
	// overlap the speculative STT hides in (turn-paid STT went 0ms → 163ms
	// median) — with no clear split-rate change at n=1. Staying at 900 until
	// the offline endpointing replay (experiments/endpointing) picks a winner
	// on the full take corpus; the real cut is semantic endpointing, not a
	// shorter energy window.
	confirmSilenceMs: 900,
	minSpeechMs: 200,
	frameMs: 20,
};

export type TurnEvent =
	/** The far end started speaking (first speech frame after silence). */
	| { readonly type: 'speech-start'; readonly atMs: number }
	/** Silence long enough that the turn is PLAUSIBLY over — advisory, may be
	 * followed by 'turn-resumed' (then it meant nothing) or by 'turn-end'.
	 * Speculative work (an early STT) may start here and must be discarded on
	 * resume. */
	| { readonly type: 'turn-maybe-end'; readonly atMs: number }
	/** Speech resumed inside the confirm window: the SAME turn continues (the
	 * re-attach that keeps a mid-sentence pause from splitting an utterance),
	 * and anything speculated at maybe-end is now stale — cancel it. This is
	 * the energy-VAD analogue of Deepgram Flux's TurnResumed. */
	| { readonly type: 'turn-resumed'; readonly atMs: number }
	/** The far end has been silent past the confirm window — reply now. */
	| { readonly type: 'turn-end'; readonly atMs: number; readonly spokeMs: number };

/** Mean |PCM| of one mulaw frame — the same speech/silence measure the
 * detector uses, exported so a consumer (e.g. a barge-in guard needing
 * "sustained speech, not a blip") applies the identical yardstick. */
export function frameEnergy(mulaw: Uint8Array): number {
	const pcm = decodeMulaw(mulaw);
	let sum = 0;
	for (const s of pcm) sum += Math.abs(s);
	return pcm.length > 0 ? sum / pcm.length : 0;
}

/**
 * Stateful, single far-end stream. Feed it inbound mulaw frames in order with
 * their session-clock `atMs`; it returns a TurnEvent when a boundary is
 * crossed, else null. One detector per turn — construct a fresh one, or call
 * `reset`, when the bench takes its own turn.
 */
export class EnergyTurnDetector {
	readonly #cfg: TurnDetectorConfig;
	#speaking = false;
	#speechStartMs: number | null = null;
	#lastSpeechMs: number | null = null;
	/** Accumulated speech time across the whole (possibly re-attached) turn. */
	#spokeMs = 0;
	#maybeEnded = false;
	#ended = false;

	constructor(cfg: TurnDetectorConfig = DEFAULT_TURN_CONFIG) {
		this.#cfg = cfg;
	}

	reset(): void {
		this.#speaking = false;
		this.#speechStartMs = null;
		this.#lastSpeechMs = null;
		this.#spokeMs = 0;
		this.#maybeEnded = false;
		this.#ended = false;
	}

	/** Feed one inbound frame. Returns an event at a boundary, else null. */
	push(mulaw: Uint8Array, atMs: number): TurnEvent | null {
		if (this.#ended) return null;
		const isSpeech = frameEnergy(mulaw) >= this.#cfg.speechEnergy;

		if (isSpeech) {
			this.#lastSpeechMs = atMs;
			this.#spokeMs += this.#cfg.frameMs;
			// Resuming inside the confirm window re-attaches — the same turn
			// continues (the fix for the mid-sentence split) — and SAYS SO, so a
			// consumer that speculated at maybe-end knows to discard.
			const resumed = this.#maybeEnded;
			this.#maybeEnded = false;
			if (!this.#speaking) {
				this.#speaking = true;
				if (this.#speechStartMs === null) {
					this.#speechStartMs = atMs;
					return { type: 'speech-start', atMs };
				}
			}
			return resumed ? { type: 'turn-resumed', atMs } : null;
		}

		this.#speaking = false;
		if (this.#lastSpeechMs === null || this.#speechStartMs === null) return null;
		// A blip shorter than the guard never ends anything; it also expires —
		// long silence after a blip clears it so the NEXT real utterance starts
		// a fresh turn rather than inheriting a stale start stamp.
		if (this.#spokeMs < this.#cfg.minSpeechMs) {
			if (atMs - this.#lastSpeechMs >= this.#cfg.confirmSilenceMs) {
				this.#speaking = false;
				this.#speechStartMs = null;
				this.#lastSpeechMs = null;
				this.#spokeMs = 0;
				this.#maybeEnded = false;
			}
			return null;
		}
		const silence = atMs - this.#lastSpeechMs;
		if (silence >= this.#cfg.confirmSilenceMs) {
			this.#ended = true;
			return {
				type: 'turn-end',
				atMs,
				spokeMs: this.#lastSpeechMs - this.#speechStartMs + this.#cfg.frameMs,
			};
		}
		if (silence >= this.#cfg.provisionalSilenceMs && !this.#maybeEnded) {
			this.#maybeEnded = true;
			return { type: 'turn-maybe-end', atMs };
		}
		return null;
	}
}
