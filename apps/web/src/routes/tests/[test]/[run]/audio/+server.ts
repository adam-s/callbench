import { error } from '@sveltejs/kit';
import { readRunAudio } from '$lib/server/runs.ts';
import type { RequestHandler } from './$types';

/**
 * Serves one run's frozen audio recording. This reads the file off disk (an fs
 * read — NOT a network call, so the dial fence is untouched) and verifies its
 * bytes against the artifact's frozen hash before returning them; a drifted file
 * is refused, not served. The browser's replay engine fetches this to draw the
 * waveform and play a finding's span — playback of a recording, never a dial.
 *
 * RANGE SUPPORT IS LOAD-BEARING, not an optimization. Chromium marks a media
 * resource whose server never advertises `Accept-Ranges: bytes` as UNSEEKABLE —
 * its seekable range stays empty and every `currentTime` write clamps back to
 * 0 (observed directly: a 28.4s seek at readyState 4 reading back as 0.00).
 * Without this, playRegion() and the finding deep-link's hear-this-moment are
 * silently broken however correct the client engine is.
 */
export const GET: RequestHandler = ({ params, request }) => {
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

	const total = audio.bytes.length;
	const common = {
		'content-type': audio.contentType,
		'accept-ranges': 'bytes',
		// The recording is immutable evidence keyed by a content hash; cache hard.
		'cache-control': 'public, max-age=31536000, immutable',
	};

	// `bytes=start-end` with either bound optional (suffix form `bytes=-N` gives
	// the last N bytes). Multi-range requests are refused as unsatisfiable-ish by
	// falling back to the full body — valid per RFC 9110, and no media player
	// sends them.
	const rangeHeader = request.headers.get('range');
	const match = rangeHeader?.match(/^bytes=(\d*)-(\d*)$/);
	if (match && (match[1] !== '' || match[2] !== '')) {
		let start: number;
		let end: number;
		if (match[1] === '') {
			// suffix: last N bytes ("bytes=-0" is unsatisfiable and falls through
			// to the 416 below via start >= total)
			const n = Number(match[2]);
			start = n === 0 ? total : Math.max(0, total - n);
			end = total - 1;
		} else {
			start = Number(match[1]);
			end = match[2] === '' ? total - 1 : Math.min(Number(match[2]), total - 1);
		}
		if (start >= total || start > end) {
			return new Response(null, {
				status: 416,
				headers: { ...common, 'content-range': `bytes */${total}` },
			});
		}
		return new Response(new Uint8Array(audio.bytes.subarray(start, end + 1)), {
			status: 206,
			headers: {
				...common,
				'content-range': `bytes ${start}-${end}/${total}`,
				'content-length': String(end - start + 1),
			},
		});
	}

	return new Response(new Uint8Array(audio.bytes), {
		headers: { ...common, 'content-length': String(total) },
	});
};
