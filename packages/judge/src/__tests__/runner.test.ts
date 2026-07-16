/**
 * The streaming runner — pinned OFFLINE against a mocked SSE body, the same
 * discipline the rest of the suite keeps (no network in a test). What matters:
 * the SSE frame splitter survives a byte stream chopped anywhere, deltas come
 * out in order, `run()` concatenates the same content the stream yields, and a
 * runner without `stream` reports so. The live payoff — first clause to TTS
 * before the reply finishes — rests on these being right.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	canStream,
	claudeRunner,
	openaiStreamingRunner,
	parseSseChunk,
	resolveRunner,
} from '../runner.ts';

afterEach(() => vi.restoreAllMocks());

describe('parseSseChunk — the frame splitter', () => {
	it('extracts complete data: lines and carries the partial tail', () => {
		const { payloads, rest } = parseSseChunk('data: a\n\ndata: b\n\ndata: par');
		expect(payloads).toEqual(['a', 'b']);
		expect(rest).toBe('data: par'); // not yet a whole line
	});

	it('ignores non-data lines (keep-alive comments, blanks)', () => {
		const { payloads } = parseSseChunk(': ping\n\ndata: x\n\n');
		expect(payloads).toEqual(['x']);
	});
});

/** A ReadableStream of the given string parts, as res.body yields them — the
 * chunk boundaries are deliberately NOT frame boundaries, to prove the splitter
 * reassembles across a chopped stream. */
function sseBody(parts: string[]): ReadableStream<Uint8Array> {
	const enc = new TextEncoder();
	let i = 0;
	return new ReadableStream({
		pull(controller) {
			if (i < parts.length) controller.enqueue(enc.encode(parts[i++] as string));
			else controller.close();
		},
	});
}

function stubFetch(parts: string[], status = 200) {
	globalThis.fetch = vi.fn(
		async () =>
			new Response(status === 200 ? sseBody(parts) : 'boom', {
				status,
				headers: { 'content-type': 'text/event-stream' },
			}),
	) as typeof fetch;
}

const delta = (c: string) =>
	`data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`;

describe('openaiStreamingRunner', () => {
	const runner = openaiStreamingRunner('test-model', { baseUrl: 'http://modal.test' });

	it('is stream-capable; the subprocess runner is not', () => {
		expect(canStream(runner)).toBe(true);
		expect(canStream(claudeRunner('sonnet'))).toBe(false);
	});

	it('yields deltas in order, reassembling across chopped chunks', async () => {
		// Frames split mid-line on purpose: "Hel"+"lo" and a payload cut in two.
		stubFetch([
			`data: ${JSON.stringify({ choices: [{ delta: { content: 'Hel' } }] })}`,
			'\n\n',
			delta('lo'),
			delta(' there'),
			'data: [DONE]\n\n',
		]);
		const out: string[] = [];
		for await (const d of runner.stream('hi')) out.push(d);
		expect(out).toEqual(['Hel', 'lo', ' there']);
	});

	it('run() concatenates the same content the stream yields', async () => {
		stubFetch([delta('Two '), delta('sixty '), delta('five.'), 'data: [DONE]\n\n']);
		expect(await runner.run('quote?')).toBe('Two sixty five.');
	});

	it('stops at [DONE] and ignores keep-alive/non-JSON lines', async () => {
		stubFetch([
			': keep-alive\n\n',
			delta('ok'),
			'data: not json\n\n',
			'data: [DONE]\n\n',
			delta('after'),
		]);
		const out: string[] = [];
		for await (const d of runner.stream('x')) out.push(d);
		expect(out).toEqual(['ok']); // 'after' is past [DONE], never yielded
	});

	it('throws an actionable error on a non-200, and on a missing base URL', async () => {
		stubFetch([], 500);
		await expect(runner.run('x')).rejects.toThrow(/HTTP 500/);
		const noUrl = openaiStreamingRunner('m', { baseUrl: '' });
		await expect(noUrl.run('x')).rejects.toThrow(/needs a base URL/);
	});

	it('resolveRunner wires openai: to the streaming runner', () => {
		expect(resolveRunner('openai:qwen').id).toBe('openai:qwen');
		expect(canStream(resolveRunner('openai:qwen'))).toBe(true);
	});
});
