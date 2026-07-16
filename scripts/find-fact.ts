/**
 * Fact finder — research one fitment fact into a reviewable candidate.
 *
 * AUTHORING-TIME ONLY. This is the "agent discovers, code runs" split at the
 * point it pays for itself: an agent does the one-time search, a human checks
 * it, the result freezes into a fact set, and the live path reads a table with
 * no model anywhere near it. Nothing here may be called from a verdict.
 *
 * THE SAFETY PROPERTY, and the whole reason this is safe to build:
 * **this tool cannot produce a fact that accuses anyone.** Only a
 * `high`-confidence `never-offered` licenses a FAIL (docs/diagnosis.md), and the
 * prompt tops out at `medium`. So it can populate every verdict that does not
 * accuse — which is most of them — while the accusing one stays on the human
 * path that cost a full research pass for a single fact. Coverage scales; the
 * accusation does not.
 *
 * Output is a CANDIDATE, written to data/facts/ and never straight into a fact
 * set. It is not evidence, it is a starting point with its sources attached.
 *
 * Usage:
 *   node scripts/find-fact.ts --vehicle "2009 Audi A3 (8P)" --feature "forward-facing ADAS camera"
 *   node scripts/find-fact.ts ... --market "US" --model claude-sonnet-5
 *
 * Bounded: one research call, one hard timeout. It places no phone call and
 * touches nothing but the model endpoint.
 */

import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RunnerError } from '@callbench/judge';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROMPT_PATH = join(HERE, 'probes', 'prompts', 'fact-finder.md');
const OUT_DIR = join(HERE, '..', 'data', 'facts');

/** One research call is allowed to be slow — it is reading the web — but it is
 * still bounded before it starts (AGENTS.md). */
const TIMEOUT_MS = 10 * 60_000;

type Status = 'never-offered' | 'optional' | 'standard' | 'unresolved';
type Confidence = 'low' | 'medium';

interface Evidence {
	tier: 'primary' | 'secondary' | 'community';
	url: string;
	what_it_says: string;
	supports: 'status' | 'against';
}

interface Candidate {
	status: Status;
	confidence: Confidence;
	reasoning: string;
	evidence: Evidence[];
	refutation_attempted: string;
	what_would_settle_it: string;
	argument_from_silence: boolean;
}

const STATUSES: Status[] = ['never-offered', 'optional', 'standard', 'unresolved'];
const CONFIDENCES: Confidence[] = ['low', 'medium'];

/**
 * A research runner — `claude -p` WITH web tools. It lives here and not in
 * `packages/judge` on purpose.
 *
 * **The judge's runner must never have web access.** The whole design keeps the
 * fact set out of the model's context so it cannot be anchored to a conclusion
 * (docs/diagnosis.md); a judge that can search the web can fetch the fact
 * itself, and the property is gone — without a single line of the prompt
 * changing. Shipping a tool-enabled runner from the judge package would put that
 * foot-gun one import away from the seam it breaks. Research reads the world and
 * runs at authoring time; judging reads the text in front of it and runs
 * offline. Different jobs, different runners, and the separation is the safeguard.
 *
 * Discovered by running it: the judge's runner spawns `claude -p` with no
 * `--allowedTools`, so the first fact-finding attempt had no WebSearch. The
 * model refused to invent citations rather than produce a fluent, plausible,
 * unverifiable answer — which is the failure this whole tool is built to
 * prevent, declined unprompted.
 */
function researchRunner(
	model: string,
	timeoutMs: number,
): { id: string; run(p: string): Promise<string> } {
	return {
		id: `claude-research:${model}`,
		run(prompt: string): Promise<string> {
			return new Promise((resolve, reject) => {
				const child = spawn(
					'claude',
					[
						'-p',
						'--output-format',
						'json',
						'--model',
						model,
						'--allowedTools',
						'WebSearch',
						'WebFetch',
					],
					{ stdio: ['pipe', 'pipe', 'pipe'] },
				);
				let out = '';
				let err = '';
				const timer = setTimeout(() => {
					child.kill('SIGKILL');
					reject(new RunnerError(`claude exceeded ${timeoutMs}ms and was terminated`));
				}, timeoutMs);
				child.stdout.on('data', (d) => {
					out += d;
				});
				child.stderr.on('data', (d) => {
					err += d;
				});
				child.on('error', () =>
					reject(new RunnerError("the Claude Code CLI (`claude`) isn't on your PATH")),
				);
				child.on('close', (code) => {
					clearTimeout(timer);
					if (code !== 0)
						return reject(new RunnerError(`claude exited ${code}: ${err.slice(0, 300)}`));
					let wrapper: { result?: string; is_error?: boolean };
					try {
						wrapper = JSON.parse(out) as { result?: string; is_error?: boolean };
					} catch {
						return reject(
							new RunnerError(
								`claude output was not the expected JSON wrapper: ${out.slice(0, 200)}`,
							),
						);
					}
					if (wrapper.is_error)
						return reject(new RunnerError(`claude errored: ${wrapper.result ?? ''}`));
					if (typeof wrapper.result !== 'string')
						return reject(new RunnerError('claude reply carried no result text'));
					resolve(wrapper.result);
				});
				child.stdin.end(prompt);
			});
		},
	};
}

function flag(argv: string[], name: string): string | null {
	const i = argv.indexOf(name);
	if (i === -1) return null;
	const v = argv[i + 1];
	if (v === undefined || v.startsWith('--')) throw new Error(`${name} needs a value`);
	return v;
}

function parseCandidate(reply: string): Candidate {
	const fenced = reply.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
	const bare = reply.match(/\{[\s\S]*\}/);
	const raw = fenced?.[1] ?? bare?.[0];
	if (!raw) throw new Error(`no JSON object in reply: ${reply.slice(0, 300)}`);
	const o = JSON.parse(raw) as Partial<Candidate>;

	if (!o.status || !STATUSES.includes(o.status))
		throw new Error(`status is ${JSON.stringify(o.status)}, not one of ${STATUSES.join(' | ')}`);
	// The cap is enforced HERE, not just requested in the prompt. A tool whose
	// only safeguard is asking a model nicely is not a safeguard — the gate is
	// that the path does not exist. A model that returns "high" is refused, not
	// silently downgraded: a downgrade would hide that the prompt was ignored.
	if (!o.confidence || !CONFIDENCES.includes(o.confidence))
		throw new Error(
			`confidence is ${JSON.stringify(o.confidence)}; this tool may only emit ${CONFIDENCES.join(' | ')}. ` +
				'`high` is reserved for a human-verified fact and is the only level that may license a FAIL.',
		);
	if (!Array.isArray(o.evidence)) throw new Error('evidence must be an array');
	for (const f of ['reasoning', 'refutation_attempted', 'what_would_settle_it'] as const)
		if (typeof o[f] !== 'string' || o[f].trim() === '') throw new Error(`${f} is missing or empty`);
	if (typeof o.argument_from_silence !== 'boolean')
		throw new Error('argument_from_silence must be a boolean');
	return o as Candidate;
}

function slug(s: string): string {
	return s
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-|-$/g, '');
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const vehicle = flag(argv, '--vehicle');
	const feature = flag(argv, '--feature');
	const market = flag(argv, '--market') ?? 'any market';
	const modelId = flag(argv, '--model') ?? 'claude-sonnet-5';
	if (!vehicle || !feature) {
		console.error(
			'usage: find-fact.ts --vehicle "<year make model>" --feature "<feature>" [--market US]',
		);
		process.exit(1);
	}
	if (!/-\d/.test(modelId))
		throw new Error(`--model ${modelId} looks like an alias; pass a concrete id`);

	const prompt = readFileSync(PROMPT_PATH, 'utf8')
		.replace(/<!--[\s\S]*?-->/g, '')
		.replaceAll('<<VEHICLE>>', () => vehicle)
		.replaceAll('<<FEATURE>>', () => feature)
		.replaceAll('<<MARKET>>', () => market);
	const left = prompt.match(/<<[A-Z_]+>>/g);
	if (left) throw new Error(`unfilled placeholder(s) ${[...new Set(left)].join(', ')}`);

	console.log(`researching: ${feature} on ${vehicle} (${market}) via claude:${modelId}\n`);
	const reply = await researchRunner(modelId, TIMEOUT_MS).run(prompt);
	const c = parseCandidate(reply);

	mkdirSync(OUT_DIR, { recursive: true });
	const path = join(OUT_DIR, `${slug(vehicle)}--${slug(feature)}.json`);
	writeFileSync(
		path,
		`${JSON.stringify(
			{
				$comment:
					'CANDIDATE, not a fact. Produced by scripts/find-fact.ts. A human reviews it before it enters a fact set. ' +
					'Its confidence can never exceed `medium`, so it can never license a FAIL — see docs/diagnosis.md.',
				vehicle,
				feature,
				market,
				researchedBy: `claude-research:${modelId}`,
				promptSha256: null,
				...c,
			},
			null,
			2,
		)}\n`,
	);

	const bar = '─'.repeat(60);
	console.log(bar);
	console.log(`status     : ${c.status}`);
	console.log(
		`confidence : ${c.confidence}${c.argument_from_silence ? '  (argument from silence)' : ''}`,
	);
	console.log(`reasoning  : ${c.reasoning}`);
	console.log(`refutation : ${c.refutation_attempted}`);
	console.log(`would settle: ${c.what_would_settle_it}`);
	console.log(`\nevidence (${c.evidence.length}):`);
	for (const e of c.evidence)
		console.log(
			`  [${e.tier}${e.supports === 'against' ? ', AGAINST' : ''}] ${e.url}\n      ${e.what_it_says.slice(0, 110)}`,
		);
	console.log(bar);
	console.log(`\ncandidate: ${path}`);
	console.log('This is a candidate. It is not in any fact set until a human puts it there.');
	if (c.status === 'never-offered')
		console.log(
			'\nNOTE: a `never-offered` row is the only kind that can accuse a business, and it needs\n' +
				'`high` confidence to do so — which this tool cannot produce. To promote it, a human must\n' +
				'verify it against a primary source and try to refute it (docs/diagnosis.md).',
		);
}

main().catch((e: unknown) => {
	console.error(`\nfact finder failed: ${e instanceof Error ? e.message : e}`);
	if (e instanceof RunnerError) console.error('The runner failed; no candidate was written.');
	console.error('Not retrying. Surface this to the operator.');
	process.exit(1);
});
