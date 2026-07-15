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
	 * message on any failure (not installed, auth, bad output). */
	run(prompt: string): Promise<string>;
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

/** Resolve a `provider:model` selector to a runner. Extend as providers land. */
export function resolveRunner(selector: string): Runner {
	const [provider, ...rest] = selector.split(':');
	const model = rest.join(':');
	switch (provider) {
		case 'claude':
			return claudeRunner(model || 'sonnet');
		default:
			throw new RunnerError(
				`unknown runner "${selector}". Supported: claude:<model>. (openai:/cmd: are additive when needed.)`,
			);
	}
}
