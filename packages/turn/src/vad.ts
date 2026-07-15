/**
 * Turn-taking: deciding when the far end has stopped speaking, so the bench
 * knows when to reply. This runs in the LIVE 20ms path (docs/models.md), so it
 * is local and cheap — it never crosses the network.
 *
 * This is an ENERGY VAD: it tracks speech vs silence by frame loudness and
 * declares end-of-turn after a run of trailing silence. It is deliberately the
 * simple version, and its limitation is real and named:
 *
 *   A silence timer cannot tell "finished the thought" from "paused mid-
 *   sentence." References.md's smart-turn reads the waveform semantically —
 *   including the filler words ("um") that mark an UNfinished turn — and is the
 *   upgrade path. This VAD sits behind the same `TurnDetector` shape so that
 *   swap is additive, per the one-interface rule.
 *
 * Adequate for Increment 2's scripted exchange (fixed lines, clear gaps).
 * Increment 6's improvised persona is where the smarter detector earns its keep.
 */

import { decodeMulaw } from '@callbench/transport';

export interface TurnDetectorConfig {
	/** Mean |PCM| above this counts a frame as speech. The PSTN noise floor
	 * sits well below a real voice; tune against captured audio, not a guess. */
	readonly speechEnergy: number;
	/** Trailing silence this long (ms) after speech = end of turn. Too short
	 * clips a mid-sentence breath; too long makes the bench feel slow. */
	readonly hangoverMs: number;
	/** Frame duration (ms). Twilio media frames are 20ms. */
	readonly frameMs: number;
}

export const DEFAULT_TURN_CONFIG: TurnDetectorConfig = {
	speechEnergy: 500,
	hangoverMs: 700,
	frameMs: 20,
};

export type TurnEvent =
	/** The far end started speaking (first speech frame after silence). */
	| { readonly type: 'speech-start'; readonly atMs: number }
	/** The far end has been silent long enough after speaking — reply now. */
	| { readonly type: 'turn-end'; readonly atMs: number; readonly spokeMs: number };

function frameEnergy(mulaw: Uint8Array): number {
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
	#ended = false;

	constructor(cfg: TurnDetectorConfig = DEFAULT_TURN_CONFIG) {
		this.#cfg = cfg;
	}

	reset(): void {
		this.#speaking = false;
		this.#speechStartMs = null;
		this.#lastSpeechMs = null;
		this.#ended = false;
	}

	/** Feed one inbound frame. Returns an event at a boundary, else null. */
	push(mulaw: Uint8Array, atMs: number): TurnEvent | null {
		if (this.#ended) return null;
		const isSpeech = frameEnergy(mulaw) >= this.#cfg.speechEnergy;

		if (isSpeech) {
			this.#lastSpeechMs = atMs;
			if (!this.#speaking) {
				this.#speaking = true;
				this.#speechStartMs = atMs;
				return { type: 'speech-start', atMs };
			}
			return null;
		}

		// Silence. If we were speaking and the hangover has elapsed, end the turn.
		if (this.#speaking && this.#lastSpeechMs !== null && this.#speechStartMs !== null) {
			if (atMs - this.#lastSpeechMs >= this.#cfg.hangoverMs) {
				this.#ended = true;
				return {
					type: 'turn-end',
					atMs,
					spokeMs: this.#lastSpeechMs - this.#speechStartMs + this.#cfg.frameMs,
				};
			}
		}
		return null;
	}
}
