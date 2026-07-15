import { error } from '@sveltejs/kit';
import { canReplay, loadRun, readRunAudio } from '$lib/server/runs.ts';
import { peaksFromWav } from '$lib/server/waveform.ts';
import type { PageServerLoad } from './$types';

/** How many columns of waveform envelope to precompute. A fixed count keeps the
 * page payload bounded regardless of call length; the canvas stretches them. */
const WAVE_COLUMNS = 900;

/**
 * One run: the full frozen transcript and the report over it. Loading
 * re-verifies the hash; a drifted artifact throws, which becomes a 500 here
 * rather than a page rendered with a warning (ui.md's refuse-don't-warn rule).
 * A missing run is a 404.
 */
export const load: PageServerLoad = ({ params }) => {
	let artifact: ReturnType<typeof loadRun>;
	try {
		artifact = loadRun(params.test, params.run);
	} catch (e) {
		// Distinguish "not here" from "here but refused". A hash/body-mismatch
		// refusal is a 500 (the evidence is corrupt); a missing file is a 404. The
		// internal detail is logged server-side, never handed to the client — the
		// client sees a fixed message so a corrupt file cannot leak a path or stack.
		const message = e instanceof Error ? e.message : String(e);
		if (/ENOENT|no such file/i.test(message)) {
			error(404, `run ${params.run} not found for scenario ${params.test}`);
		}
		console.error(`[run route] refusing ${params.test}/${params.run}: ${message}`);
		error(500, 'this run could not be loaded: the evidence is corrupt or drifted from its hash.');
	}

	// Audio (if any): the peaks are computed from the SAME verified bytes the audio
	// route serves, server-side, so the client never fetches audio to draw the
	// waveform (which the dial fence forbids). A run with no audio simply has none.
	let audio: {
		url: string;
		durationMs: number;
		synthetic: string | null;
		peaks: ReadonlyArray<readonly [number, number]>;
	} | null = null;
	// Audio is EVIDENCE, offered for any run that has a recording — including a
	// system-under-test call, which is exactly what the bench exists to let a
	// human hear. Playback is not a dial: it plays a frozen file. The dial fence
	// (canReplay) gates a re-RUN control, which does not exist in the UI; it must
	// not gate playback, or the centerpiece would be unavailable for real calls.
	if (artifact.audio) {
		const { bytes } = readRunAudio(params.test, params.run);
		audio = {
			url: `/tests/${params.test}/${params.run}/audio`,
			durationMs: artifact.audio.durationMs,
			synthetic: artifact.audio.synthetic,
			peaks: peaksFromWav(bytes, WAVE_COLUMNS),
		};
	}

	return {
		scenario: artifact.scenario,
		runId: artifact.runId,
		target: artifact.target,
		createdEpochMs: artifact.createdEpochMs,
		turns: artifact.transcript.turns,
		results: artifact.report.results,
		verdicts: artifact.report.verdicts,
		counts: artifact.report.counts,
		audio,
		// The fence, decided server-side and passed as a fact: only a simulator run
		// exposes a replay control, and even then replay is a browser-side playback
		// of a frozen recording — no path here reaches a phone.
		replayable: canReplay(artifact.target),
	};
};
