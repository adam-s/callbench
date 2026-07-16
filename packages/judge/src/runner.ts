/**
 * The model runner — a `provider:model` selector mapping a prompt to reply text,
 * adopted from goldseam (docs/references.md). The judge stage never learns which
 * model or host produced a verdict; identity is recorded as a tag. Selection is
 * a string, so `claude -p`, a Modal endpoint, or a local process are three
 * adapters behind one shape, swapped by config, never by code.
 *
 * Only the `claude:` runner is built here — the judge's chosen production runner
 * (docs/models.md). `openai:` (Modal) and `cmd:` follow the same interface when
 * they are needed; the seam is what makes that additive.
 */

import { spawn } from 'node:child_process';

export class RunnerError extends Error {}

export interface Runner {
	/** Stable id, e.g. `claude:sonnet` — recorded on every verdict as its model. */
	readonly id: string;
	/** Map a prompt to raw reply text. Throws RunnerError with an actionable
	 * message on any failure (not installed, auth, bad output). The judge uses
	 * this — it is offline and wants the whole verdict, so streaming buys it
	 * nothing. A streaming runner implements this by concatenating its stream. */
	run(prompt: string): Promise<string>;
	/** Optional token stream — yields deltas as the model produces them. Present
	 * only on runners that can stream (the live persona's fast path: first
	 * clause to TTS before the reply exists). Absent on the subprocess runner,
	 * whose whole cost is that it cannot stream. */
	stream?(prompt: string): AsyncGenerator<string>;
}

/** True when a runner can stream — the live path checks this to choose the
 * fast route and fall back to `run()` on a runner that cannot. */
export function canStream(r: Runner): r is Runner & { stream(p: string): AsyncGenerator<string> } {
	return typeof r.stream === 'function';
}

/** Spawn a process, write the prompt to stdin, resolve stdout. Bounded by
 * `timeoutMs` — a run is bounded before it starts (AGENTS.md). */
function spawnText(
	command: string,
	args: string[],
	stdin: string,
	timeoutMs: number,
	notFoundHint: string,
): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
		let out = '';
		let err = '';
		const timer = setTimeout(() => {
			child.kill('SIGKILL');
			reject(new RunnerError(`${command} exceeded ${timeoutMs}ms and was terminated`));
		}, timeoutMs);
		child.stdout.on('data', (d) => (out += d));
		child.stderr.on('data', (d) => (err += d));
		child.stdin.on('error', () => {}); // swallow EPIPE if the child exits early
		child.on('error', (e) => {
			clearTimeout(timer);
			const code = (e as NodeJS.ErrnoException).code;
			reject(new RunnerError(code === 'ENOENT' ? notFoundHint : `${command}: ${e.message}`));
		});
		child.on('close', (code) => {
			clearTimeout(timer);
			if (code !== 0) reject(new RunnerError(`${command} exited ${code}: ${err.slice(0, 400)}`));
			else resolve(out);
		});
		child.stdin.write(stdin);
		child.stdin.end();
	});
}

const CLAUDE_MISSING =
	"the Claude Code CLI (`claude`) isn't on your PATH — install it, or select a different runner";

/**
 * `claude:<model>` — the Claude Code CLI in print mode. The prompt goes on
 * stdin; `--output-format json` returns a wrapper carrying the model's reply in
 * `result` and any error in `is_error` (verified against the real CLI).
 */
export function claudeRunner(model: string, timeoutMs = 90_000): Runner {
	return {
		id: `claude:${model}`,
		async run(prompt: string): Promise<string> {
			const raw = await spawnText(
				'claude',
				['-p', '--output-format', 'json', '--model', model],
				prompt,
				timeoutMs,
				CLAUDE_MISSING,
			);
			let wrapper: { result?: string; is_error?: boolean };
			try {
				wrapper = JSON.parse(raw) as { result?: string; is_error?: boolean };
			} catch (e) {
				throw new RunnerError(
					`claude output was not the expected JSON wrapper: ${e instanceof Error ? e.message : e}`,
				);
			}
			if (wrapper.is_error) {
				throw new RunnerError(`claude returned an error: ${wrapper.result ?? '(no detail)'}`);
			}
			if (typeof wrapper.result !== 'string') {
				throw new RunnerError('claude reply carried no result text');
			}
			return wrapper.result;
		},
	};
}

/**
 * Parse one Server-Sent-Events buffer into complete `data:` payloads, returning
 * the payloads found and the trailing partial line to carry to the next chunk.
 * SSE frames are `data: <json>\n\n`; a network chunk can split one anywhere, so
 * the leftover after the last newline is not yet a whole line. Exported for the
 * test that pins exactly this splitting.
 */
export function parseSseChunk(buffer: string): { payloads: string[]; rest: string } {
	const lines = buffer.split('\n');
	const rest = lines.pop() ?? ''; // last element is the incomplete tail
	const payloads: string[] = [];
	for (const line of lines) {
		const t = line.trim();
		if (t.startsWith('data:')) payloads.push(t.slice(5).trim());
	}
	return { payloads, rest };
}

/**
 * `openai:<model>` — any OpenAI-compatible chat endpoint that STREAMS (the Modal
 * vLLM server, or a hosted OpenAI/Groq/etc. base URL). This is the live path's
 * fast runner: it opens a `stream: true` completion and yields each token delta
 * the instant it arrives, so the caller can hand the first clause to TTS before
 * the reply is finished — the fix for the measured 4.7s LLM block (the
 * subprocess `claude` runner cannot stream at all). `run()` is the same call
 * with the deltas concatenated, for the offline judge.
 *
 * The base URL comes from `MODAL_LLM_URL` (or `OPENAI_BASE_URL`); the key from
 * `OPENAI_API_KEY` when the endpoint wants one (a self-hosted vLLM usually does
 * not). Bounded by `timeoutMs`. Prefix caching (vLLM `--enable-prefix-caching`)
 * lives on the SERVER, not here — a fixed persona system prompt then re-uses its
 * KV cache turn over turn, which is where the biggest self-hosted TTFT win is.
 */
export function openaiStreamingRunner(
	model: string,
	opts: { baseUrl?: string; apiKey?: string; timeoutMs?: number } = {},
): Runner {
	const baseUrl = (opts.baseUrl ?? process.env.MODAL_LLM_URL ?? process.env.OPENAI_BASE_URL ?? '')
		.replace(/\/$/, '')
		.replace(/\/v1$/, '');
	const apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY;
	const timeoutMs = opts.timeoutMs ?? 60_000;

	async function* stream(prompt: string): AsyncGenerator<string> {
		if (!baseUrl) {
			throw new RunnerError(
				'openai: runner needs a base URL — set MODAL_LLM_URL (the deployed vLLM) or OPENAI_BASE_URL.',
			);
		}
		const res = await fetch(`${baseUrl}/v1/chat/completions`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
			},
			body: JSON.stringify({
				model,
				stream: true,
				messages: [{ role: 'user', content: prompt }],
			}),
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (!res.ok || !res.body) {
			throw new RunnerError(
				`openai: endpoint ${baseUrl} returned HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`,
			);
		}
		const decoder = new TextDecoder();
		let buffer = '';
		for await (const part of res.body as unknown as AsyncIterable<Uint8Array>) {
			buffer += decoder.decode(part, { stream: true });
			const { payloads, rest } = parseSseChunk(buffer);
			buffer = rest;
			for (const payload of payloads) {
				if (payload === '[DONE]') return;
				let delta: string | undefined;
				try {
					delta = (JSON.parse(payload) as { choices?: Array<{ delta?: { content?: string } }> })
						.choices?.[0]?.delta?.content;
				} catch {
					// a keep-alive or a non-JSON line — skip, do not abort the stream
				}
				if (delta) yield delta;
			}
		}
	}

	return {
		id: `openai:${model}`,
		stream,
		async run(prompt: string): Promise<string> {
			let out = '';
			for await (const delta of stream(prompt)) out += delta;
			return out;
		},
	};
}

/** Resolve a `provider:model` selector to a runner. Extend as providers land. */
export function resolveRunner(selector: string): Runner {
	const [provider, ...rest] = selector.split(':');
	const model = rest.join(':');
	switch (provider) {
		case 'claude':
			return claudeRunner(model || 'sonnet');
		case 'openai':
			return openaiStreamingRunner(model || 'default');
		default:
			throw new RunnerError(
				`unknown runner "${selector}". Supported: claude:<model> (subprocess), openai:<model> (streaming). cmd: is additive when needed.`,
			);
	}
}
