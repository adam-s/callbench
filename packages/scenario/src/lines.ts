/**
 * Model-line machinery shared by BOTH model speakers — the caller persona and
 * the rehearsal shop agent. Each speaker owns its prompt and its policy; what
 * lives here is the line handling that must behave identically on either side
 * of the call: how a streamed reply yields its first speakable clause, how a
 * runaway reply is capped at a sentence, and how the DONE control token is
 * kept out of anything spoken aloud. One implementation, so a fix on one side
 * (e.g. the DONE-spoken-aloud failure, take 1784211829214) can never silently
 * miss the other.
 */

/** One side of the exchange as a model sees it. */
export interface ExchangeTurn {
	readonly speaker: 'caller' | 'agent';
	readonly text: string;
}

/** The exchange rendered as prompt lines — `CALLER:`/`AGENT:` labels, one turn
 * per line, identical in both speakers' prompts so a transcript reads the same
 * whichever side's prompt it appears in. */
export function renderExchange(exchange: readonly ExchangeTurn[]): string[] {
	return exchange.map((t) => `${t.speaker === 'caller' ? 'CALLER' : 'AGENT'}: ${t.text}`);
}

/** A reply's first line, trimmed — a model told to answer with one utterance
 * sometimes appends commentary on later lines; only the first is the reply. */
export function firstLine(raw: string): string {
	return raw.trim().split('\n')[0]?.trim() ?? '';
}

/** A runaway reply truncated at a sentence boundary inside `cap` — a spoken
 * line, not an essay. The raw reply stays in the record untrimmed; only what
 * reaches TTS is capped. */
export function capAtSentence(text: string, cap: number): string {
	if (text.length <= cap) return text;
	const cut = text.slice(0, cap);
	return cut.slice(
		0,
		Math.max(cut.lastIndexOf('.'), cut.lastIndexOf('?'), cut.lastIndexOf('!')) + 1 || cap,
	);
}

/** The first complete clause in `text`, or null if no confirmed boundary yet.
 * A boundary is `.?!` FOLLOWED BY whitespace (or a quote) — punctuation alone
 * is not enough, because in a live stream a trailing `.` may be the middle of
 * `3.5` or `$249.99` with the next digit still in flight. The clause must also
 * contain a space (two+ words): a one-word "clause" is either an abbreviation
 * (`Mr.`) or a control token (`DONE.`), and speaking either aloud is worse
 * than waiting for the full line. The cost of the stricter rule is that a
 * single-clause reply never fires early — where early fire saves ~nothing,
 * since the clause finishing IS the reply finishing. */
export function firstClause(text: string): string | null {
	const s = text.trimStart();
	const boundary = /[.?!]+["']?(?=\s)/g;
	for (let m = boundary.exec(s); m !== null; m = boundary.exec(s)) {
		const clause = s.slice(0, m.index + m[0].length).trim();
		// A one-word candidate extends to the next boundary instead of firing —
		// or never fires, which is safe. This single rule covers abbreviations
		// (`Mr.`) AND the DONE control token: every DONE shape is one word, so
		// nothing DONE-like can ever reach TTS through here.
		if (!clause.includes(' ')) continue;
		return clause;
	}
	return null;
}

/** Accumulate a streamed reply, firing `onFirstClause` the instant the model
 * has produced one confirmed clause — the latency lever: TTS starts on the
 * clause while the model finishes the line. `firstClause` refuses one-word
 * clauses (which covers every DONE shape) and unconfirmed boundaries
 * (mid-decimal dots), so a control token or a number fragment can never be
 * spoken early. */
export async function streamWithFirstClause(
	stream: AsyncIterable<string>,
	onFirstClause?: (clause: string) => void,
): Promise<{ acc: string; firedClause: string | null; firstClauseMs: number | null }> {
	const started = performance.now();
	let acc = '';
	let firedClause: string | null = null;
	let firstClauseMs: number | null = null;
	for await (const delta of stream) {
		acc += delta;
		if (firedClause === null && onFirstClause) {
			const clause = firstClause(acc);
			if (clause) {
				firedClause = clause;
				firstClauseMs = performance.now() - started;
				onFirstClause(clause);
			}
		}
	}
	return { acc, firedClause, firstClauseMs };
}

/** The DONE convention, tolerantly: the bare token optionally wrapped in
 * quotes and/or trailed by sentence punctuation. Used to keep the control
 * token out of anything spoken aloud. */
export function isDoneToken(text: string): boolean {
	return /^["']?DONE["']?[.?!]?$/.test(text.trim());
}

/** A DONE the model appended to prose ("Thanks, that's all. DONE.") — the
 * observed failure mode (take 1784211829214: the token was synthesized and
 * spoken three times). Stripped before anything reaches TTS; the remaining
 * prose is the farewell, and the turn still ends the persona's part. */
const DONE_TAIL = /\s*\bDONE\b["']?[.?!]*\s*$/;

/** Split a reply line into what may be SPOKEN and whether it ended the
 * persona's part: a bare DONE speaks nothing; prose + DONE speaks the prose
 * and ends; plain prose speaks and continues. */
export function splitDoneTail(line: string): { speak: string; done: boolean } {
	if (isDoneToken(line)) return { speak: '', done: true };
	if (DONE_TAIL.test(line)) return { speak: line.replace(DONE_TAIL, '').trim(), done: true };
	return { speak: line, done: false };
}
