import { error } from '@sveltejs/kit';
import { readRunAudio } from '$lib/server/runs.ts';
import type { RequestHandler } from './$types';

/**
 * Serves one run's frozen audio recording. This reads the file off disk (an fs
 * read — NOT a network call, so the dial fence is untouched) and verifies its
 * bytes against the artifact's frozen hash before returning them; a drifted file
 * is refused, not served. The browser's replay engine fetches this to draw the
 * waveform and play a finding's span — playback of a recording, never a dial.
 */
export const GET: RequestHandler = ({ params }) => {
	let audio: ReturnType<typeof readRunAudio>;
	try {
		audio = readRunAudio(params.test, params.run);
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		if (/ENOENT|no such file|has no audio/i.test(message)) {
			error(404, 'no audio for this run');
		}
		console.error(`[audio route] refusing ${params.test}/${params.run}: ${message}`);
		error(500, 'the audio for this run could not be served (it is corrupt or refused).');
	}
	return new Response(new Uint8Array(audio.bytes), {
		headers: {
			'content-type': audio.contentType,
			'content-length': String(audio.bytes.length),
			// The recording is immutable evidence keyed by a content hash; cache hard.
			'cache-control': 'public, max-age=31536000, immutable',
		},
	});
};
