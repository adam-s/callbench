/**
 * Author a scenario, end to end — the procedure in
 * .agents/skills/author-scenario/SKILL.md, run as a pipeline.
 *
 * Four stages, each a bounded `claude -p` call:
 *
 *   1. FACT        find-fact.ts researches the fitment    -> candidate, <= medium
 *   2. CALLER      draft what the caller says             -> draft turns
 *   3. GATE        connotation pass, BLIND to stage 2     -> phrase->readings
 *   4. EMIT        assemble a draft scenario + artifacts
 *
 * WHAT THIS PRODUCES IS A DRAFT. It is not a scenario, it does not dial, and
 * nothing here may ship without a human reading it. Two hard properties make
 * that safe rather than aspirational:
 *
 *   - **The fact cannot accuse.** find-fact caps at `medium` in code, and only a
 *     human-`verified` `never-offered` licenses a FAIL (docs/diagnosis.md). A
 *     scenario authored entirely by this script can PASS and abstain; it cannot
 *     print an accusation at a business.
 *   - **The gate is blind.** Stage 3 receives the LINES and nothing about who
 *     wrote them or why. A drafter reviewing its own draft defends it — CoVe
 *     measured factored-vs-joint verification and independence is the active
 *     ingredient (arXiv 2309.11495); framing a reviewer moved detection 16-93
 *     points in the nearest analogue (arXiv 2603.18740). Passing stage 2's
 *     reasoning into stage 3 would forfeit the only thing stage 3 is for.
 *
 * Usage:
 *   node scripts/author-scenario.ts --vehicle "2012 Ford F-150" \
 *        --service "a windshield quote" \
 *        --probe "Does it need a camera recalibration afterward?" \
 *        --feature "forward-facing ADAS camera"
 *   ... --model claude-sonnet-5 --skip-fact
 */

import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RunnerError } from '@callbench/judge';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROMPTS = join(HERE, 'probes', 'prompts');
const OUT_DIR = join(HERE, '..', 'data', 'drafts');

/** Bounded before it starts (AGENTS.md). Four calls, hard-capped. */
const STAGE_TIMEOUT_MS = 10 * 60_000;

interface CallerTurn {
	say: string;
	probe: string | null;
	waitAfter: boolean;
	why: string;
}
interface CallerDraft {
	turns: CallerTurn[];
	humanAnswers: string;
	close: string;
	risks: string[];
}
interface Reading {
	line: string;
	literal: string;
	implies: string;
	worst: string;
	verdict: 'ships' | 'rewrite' | 'cut';
	rewrite: string | null;
	why: string;
}
interface GateResult {
	readings: Reading[];
	aiRegister: { clean: boolean; notes: string };
	verdict: 'ships' | 'needs work';
	wouldNotSay: string[];
}

function flag(argv: string[], name: string): string | null {
	const i = argv.indexOf(name);
	if (i === -1) return null;
	const v = argv[i + 1];
	if (v === undefined || v.startsWith('--')) throw new Error(`${name} needs a value`);
	return v;
}

/** `claude -p` with no tools — the drafting and gate stages read only what they
 * are given. Only the FACT stage (find-fact.ts) gets web access, and it gets it
 * from its own runner for the reason recorded there: a stage that can search can
 * fetch the answer, and a gate that can look things up stops being a gate on the
 * text in front of it. */
function run(model: string, prompt: string, tools: string[] = []): Promise<string> {
	return new Promise((resolve, reject) => {
		const args = ['-p', '--output-format', 'json', '--model', model];
		if (tools.length > 0) args.push('--allowedTools', ...tools);
		const child = spawn('claude', args, { stdio: ['pipe', 'pipe', 'pipe'] });
		let out = '';
		let err = '';
		const timer = setTimeout(() => {
			child.kill('SIGKILL');
			reject(new RunnerError(`claude exceeded ${STAGE_TIMEOUT_MS}ms`));
		}, STAGE_TIMEOUT_MS);
		child.stdout.on('data', (d) => {
			out += d;
		});
		child.stderr.on('data', (d) => {
			err += d;
		});
		child.on('error', () => reject(new RunnerError("`claude` isn't on your PATH")));
		child.on('close', (code) => {
			clearTimeout(timer);
			if (code !== 0) return reject(new RunnerError(`claude exited ${code}: ${err.slice(0, 300)}`));
			let w: { result?: string; is_error?: boolean };
			try {
				w = JSON.parse(out) as { result?: string; is_error?: boolean };
			} catch {
				return reject(new RunnerError(`not the expected JSON wrapper: ${out.slice(0, 200)}`));
			}
			if (w.is_error) return reject(new RunnerError(`claude errored: ${w.result ?? ''}`));
			if (typeof w.result !== 'string') return reject(new RunnerError('no result text'));
			resolve(w.result);
		});
		child.stdin.end(prompt);
	});
}

function json<T>(reply: string, what: string): T {
	const fenced = reply.match(/```(?:json)?\s*([[{][\s\S]*?[\]}])\s*```/);
	const bare = reply.match(/[[{][\s\S]*[\]}]/);
	const raw = fenced?.[1] ?? bare?.[0];
	if (!raw) throw new Error(`${what}: no JSON in reply: ${reply.slice(0, 250)}`);
	return JSON.parse(raw) as T;
}

function fill(path: string, values: Record<string, string>): string {
	let t = readFileSync(path, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
	for (const [k, v] of Object.entries(values)) t = t.replaceAll(`<<${k}>>`, () => v);
	const left = t.match(/<<[A-Z_]+>>/g);
	if (left) throw new Error(`${path}: unfilled ${[...new Set(left)].join(', ')}`);
	return t;
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
	const service = flag(argv, '--service') ?? 'a quote';
	const probe = flag(argv, '--probe');
	const feature = flag(argv, '--feature');
	const model = flag(argv, '--model') ?? 'claude-sonnet-5';
	const skipFact = argv.includes('--skip-fact');
	if (!vehicle || !probe) {
		console.error(
			'usage: author-scenario.ts --vehicle "<year make model>" --probe "<the question>" [--service "..."] [--feature "..."] [--skip-fact]',
		);
		process.exit(1);
	}
	if (!/-\d/.test(model))
		throw new Error(`--model ${model} looks like an alias; pass a concrete id`);

	const bar = '─'.repeat(64);
	const draft: Record<string, unknown> = {
		vehicle,
		service,
		probe,
		feature,
		authoredBy: `claude:${model}`,
	};

	// ── 1. FACT ───────────────────────────────────────────────────────────────
	if (!skipFact && feature) {
		console.log(`${bar}\n1. FACT — researching ${feature} on ${vehicle}\n${bar}`);
		console.log(
			'   (delegating to scripts/find-fact.ts — it has web access and its own medium cap)',
		);
		console.log(
			`   run: node scripts/find-fact.ts --vehicle ${JSON.stringify(vehicle)} --feature ${JSON.stringify(feature)}`,
		);
		console.log('   Skipped inline so the fact stays a reviewable artifact of its own.\n');
	}

	// ── 2. CALLER ─────────────────────────────────────────────────────────────
	console.log(`${bar}\n2. CALLER — drafting what the caller says\n${bar}`);
	const caller = json<CallerDraft>(
		await run(
			model,
			fill(join(PROMPTS, 'draft-caller.md'), { VEHICLE: vehicle, SERVICE: service, PROBE: probe }),
		),
		'caller draft',
	);
	for (const t of caller.turns)
		console.log(
			`   ${t.probe ? `[${t.probe}]` : '       '} "${t.say}"${t.waitAfter ? '  (then silence)' : ''}`,
		);
	if (caller.risks.length > 0) {
		console.log('\n   risks the drafter raised:');
		for (const r of caller.risks) console.log(`     - ${r}`);
	}
	draft.caller = caller;

	// ── 3. GATE ───────────────────────────────────────────────────────────────
	// The lines and NOTHING else. No probe, no vehicle, no rationale — see the
	// header. This stage is worth exactly as much as its blindness.
	console.log(`\n${bar}\n3. GATE — connotation pass (blind to stage 2)\n${bar}`);
	// Dedupe. `close` is usually already the last turn, so the first run handed the
	// gate the same sentence twice and it dutifully read it twice — noise in the
	// artifact a human is meant to read carefully, which is the one place noise
	// costs the most.
	const lines = [
		...new Set(
			[...caller.turns.map((t) => t.say), caller.humanAnswers, caller.close].filter(Boolean),
		),
	]
		.map((l) => `- ${l}`)
		.join('\n');
	const gate = json<GateResult>(
		await run(model, fill(join(PROMPTS, 'connotation-gate.md'), { LINES: lines })),
		'connotation gate',
	);
	for (const r of gate.readings) {
		const mark = r.verdict === 'ships' ? 'ok  ' : r.verdict === 'rewrite' ? 'EDIT' : 'CUT ';
		console.log(`   ${mark} "${r.line.slice(0, 68)}"`);
		if (r.verdict !== 'ships') {
			console.log(`        worst reading: ${r.worst}`);
			if (r.rewrite) console.log(`        rewrite      : "${r.rewrite}"`);
		}
	}
	console.log(
		`\n   AI register: ${gate.aiRegister.clean ? 'clean' : `NOT CLEAN — ${gate.aiRegister.notes}`}`,
	);
	if (gate.wouldNotSay.length > 0) {
		console.log('   would not say:');
		for (const w of gate.wouldNotSay) console.log(`     - ${w}`);
	}
	draft.connotation = gate;

	// ── 4. EMIT ───────────────────────────────────────────────────────────────
	mkdirSync(OUT_DIR, { recursive: true });
	const path = join(OUT_DIR, `${slug(vehicle)}--${slug(probe)}.json`);
	writeFileSync(
		path,
		`${JSON.stringify({ $comment: 'DRAFT. Not a scenario. Nothing here dials, and nothing ships until a human reads it — see .agents/skills/author-scenario/SKILL.md.', ...draft }, null, 2)}\n`,
	);

	console.log(`\n${bar}`);
	console.log(`draft: ${path}`);
	console.log(bar);
	console.log('\nThis is a DRAFT, not a scenario. Before it can run:');
	console.log('  - read the connotation readings above — they are the gate, not a formality');
	console.log('  - the fact stays `researched`/medium until a human verifies it, so the');
	console.log('    fabrication probe abstains rather than accuses (docs/diagnosis.md)');
	console.log('  - wire the turns into packages/scenario/src/scenarios.ts by hand');
	console.log('  - commit the connotation artifact under docs/connotation/');
	console.log("\nIt places no call. The dial is the maintainer's (.agents/skills/live-call).");

	// The gate's own verdict decides the exit code. A drafting pipeline that
	// exits 0 on "needs work" trains the reader to skip the part that matters.
	if (gate.verdict !== 'ships' || !gate.aiRegister.clean || gate.wouldNotSay.length > 0) {
		console.log('\nGATE: needs work — see above.');
		process.exitCode = 1;
	}
}

main().catch((e: unknown) => {
	console.error(`\nauthoring failed: ${e instanceof Error ? e.message : e}`);
	console.error('Not retrying. Surface this to the operator.');
	process.exit(1);
});
