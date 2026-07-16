/**
 * The latency lab — one contract, three contenders, one honest number each.
 *
 * The question is not "which model is fastest" in the abstract; it is which
 * inbound-to-outbound path gives the lowest VOICE-TO-VOICE latency for THIS
 * bench: 8kHz mulaw off Twilio in, 8kHz mulaw to the pacer out, a persona that
 * emits one short conversational sentence per turn. Every contender implements
 * the same `TurnPipeline` and is timed over the same fixtures, so the winner is
 * picked from data, not from a vendor's landing page.
 *
 * The metric that matters is TIME-TO-FIRST-AUDIO from end-of-caller-speech:
 * the silence the far end actually hears. We also record time-to-final so a
 * fast-but-truncated path can't win by cheating. All times are ms from the
 * moment the pipeline is told the caller's turn ended (`markTurnEnd`).
 */

/** 8kHz mono PCM16 — the bench's wire format, one representation everywhere. */
export type Pcm8k = Int16Array;

export interface TurnTiming {
	/** ms from markTurnEnd to the first transcript token/partial (inbound leg). */
	readonly firstTextMs: number | null;
	/** ms from markTurnEnd to the final transcript (STT done). */
	readonly finalTextMs: number | null;
	/** ms from markTurnEnd to the FIRST audio chunk out — the headline number. */
	readonly firstAudioMs: number | null;
	/** ms from markTurnEnd to the last audio chunk (whole reply synthesized). */
	readonly finalAudioMs: number | null;
	/** what the pipeline heard, and what it said — to judge quality, not just speed. */
	readonly heardText: string;
	readonly repliedText: string;
	/** any per-stage detail a contender wants to surface (cold start flag, etc). */
	readonly notes?: Record<string, string | number>;
}

/**
 * One turn of the conversation, end to end. A contender is handed the caller's
 * audio incrementally (so a streaming STT can work while the caller talks),
 * told when the turn ends, and produces reply audio chunks — recording the
 * timestamps above as it goes.
 */
export interface TurnPipeline {
	/** Contender id, e.g. "modal-selfhost", for the results table. */
	readonly id: string;
	/** Fresh per-turn state (conversation carried across turns lives in the
	 * contender; this resets the timing clock and per-turn buffers). */
	beginTurn(): void;
	/** Feed one 20ms inbound frame as it arrives — a streaming STT starts now;
	 * a batch STT buffers. Called at ~real-time cadence by the harness. */
	pushInboundFrame(frame: Pcm8k): void;
	/** The caller stopped: start the timing clock. Everything after this is
	 * latency the far end hears. Returns the completed timing once reply audio
	 * is done (or a wall-clock cap trips). `onAudio` receives each outbound
	 * chunk the instant the contender produces it. */
	markTurnEnd(onAudio: (chunk: Pcm8k) => void): Promise<TurnTiming>;
	/** Record the agreed reply into the contender's conversation memory, so the
	 * next turn has context. (What the contender actually said may differ from
	 * timing.repliedText only if truncated by a cap.) */
	commitReply(text: string): void;
	/** Release any sockets/sessions. */
	close(): Promise<void>;
}

/** A conversation fixture: alternating agent lines (spoken TO our pipeline) the
 * harness renders to audio and feeds in, so every contender faces identical
 * input. The persona goal + facts drive what the pipeline SAYS back. */
export interface TurnFixture {
	readonly name: string;
	/** What the far-end agent says each turn; the pipeline hears these (rendered
	 * to 8kHz audio by the harness) and must reply. */
	readonly agentTurns: readonly string[];
	/** The persona the pipeline plays — same across contenders. */
	readonly personaGoal: string;
	readonly personaFacts: readonly string[];
}
