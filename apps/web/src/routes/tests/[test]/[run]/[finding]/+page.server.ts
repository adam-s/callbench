import { error } from '@sveltejs/kit';
import { canReplay, loadRun, readRunAudio } from '$lib/server/runs.ts';
import { peaksFromWav } from '$lib/server/waveform.ts';
import type { PageServerLoad } from './$types';

const WAVE_COLUMNS = 900;

/**
 * The deep link — one finding within one run. `[finding]` is the assertion's
 * stable name (code result or judge verdict). This is what makes the centerpiece
 * gesture linkable: a URL names a specific claim, lands on the span it cites, and
 * (next increment) plays that moment. A finding that names no known assertion is
 * a 404, not a blank page.
 */
export const load: PageServerLoad = ({ params }) => {
	let artifact: ReturnType<typeof loadRun>;
	try {
		artifact = loadRun(params.test, params.run);
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		if (/ENOENT|no such file/i.test(message)) {
			error(404, `run ${params.run} not found for scenario ${params.test}`);
		}
		console.error(`[finding route] refusing ${params.test}/${params.run}: ${message}`);
		error(500, 'this run could not be loaded: the evidence is corrupt or drifted from its hash.');
	}

	const result = artifact.report.results.find((r) => r.assertion === params.finding);
	const verdict = artifact.report.verdicts.find((v) => v.assertion === params.finding);

	// Narrow explicitly so neither branch needs a non-null assertion: a code
	// result wins if present, else a judge verdict, else the finding does not
	// exist and the route 404s.
	let finding: {
		kind: 'code' | 'judge';
		assertion: string;
		outcome: (typeof artifact.report.results)[number]['outcome'];
		detail: string;
		span: (typeof artifact.report.results)[number]['span'];
		by: string | null;
	};
	if (result) {
		finding = {
			kind: 'code',
			assertion: result.assertion,
			outcome: result.outcome,
			detail: result.detail,
			span: result.span,
			by: null,
		};
	} else if (verdict) {
		finding = {
			kind: 'judge',
			assertion: verdict.assertion,
			outcome: verdict.outcome,
			detail: verdict.reasoning,
			span: verdict.span,
			by: verdict.judgedBy,
		};
	} else {
		error(404, `no finding named "${params.finding}" in this run`);
	}

	// Audio for the centerpiece: the deep link lands and plays the cited span.
	// Only for a replayable (simulator) run with audio; peaks computed server-side
	// from the same verified bytes, so the client never fetches audio.
	let audio: {
		url: string;
		durationMs: number;
		synthetic: string | null;
		peaks: ReadonlyArray<readonly [number, number]>;
	} | null = null;
	if (canReplay(artifact.target) && artifact.audio) {
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
		turns: artifact.transcript.turns,
		finding,
		audio,
	};
};
