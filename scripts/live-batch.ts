/**
 * Bounded batch runner for live owned-to-owned takes — the overnight harness.
 * Spawns scripts/live-scenario.ts once per planned take, SEQUENTIALLY, one
 * process and one tunnel per call: at unattended hours, isolation beats
 * throughput — a leaked socket, a degraded tunnel, or a wedged STT call dies
 * with its process instead of poisoning the rest of the night.
 *
 * Bounds, declared before anything runs (AGENTS.md):
 *   - at most MAX_TAKES per invocation, whatever the plan says;
 *   - a hard per-take wall clock (the child is killed past it, and the child
 *     itself hangs up its call on SIGTERM);
 *   - a failed take is RECORDED and the batch moves to the NEXT PLANNED take —
 *     never a retry of the failed one (a retry is a new plan, made by a human
 *     or by tomorrow's session reading tonight's report);
 *   - after MAX_CONSECUTIVE_FAILURES the batch parks itself: repeated
 *     infrastructure failure at 3am is a report for the morning, not a loop.
 *
 * Usage:
 *   node --env-file=.env scripts/live-batch.ts <spec> [<spec>…]
 *     spec = scenario[:defect][xN]   e.g. windshield-quote  stt-year-teensx3
 *            year-correction:dropCorrection
 *   Flags: --judge (default off)
 */

import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const MAX_TAKES = 12;
const PER_TAKE_WALL_MS = 6 * 60_000;
const MAX_CONSECUTIVE_FAILURES = 3;

interface Take {
	scenario: string;
	defect: string | null;
}

function parsePlan(args: string[]): Take[] {
	const takes: Take[] = [];
	for (const a of args) {
		if (a.startsWith('--')) continue;
		const m = /^([a-z0-9-]+)(?::([a-zA-Z]+))?(?:x(\d+))?$/.exec(a);
		if (!m) throw new Error(`bad spec "${a}" (scenario[:defect][xN])`);
		const n = Math.max(1, Number(m[3] ?? 1));
		for (let i = 0; i < n; i++) takes.push({ scenario: m[1] as string, defect: m[2] ?? null });
	}
	return takes;
}

function runTake(take: Take, judge: boolean): Promise<{ ok: boolean; line: string }> {
	return new Promise((resolve) => {
		const args = ['--env-file=.env', 'scripts/live-scenario.ts', '--scenario', take.scenario];
		if (take.defect) args.push('--defect', take.defect);
		if (!judge) args.push('--no-judge');
		const child = spawn('node', args, { stdio: ['ignore', 'pipe', 'pipe'] });
		let out = '';
		child.stdout.on('data', (d: Buffer) => {
			out += d.toString();
		});
		child.stderr.on('data', (d: Buffer) => {
			out += d.toString();
		});
		// SIGTERM first so the child's signal handler hangs up its live call;
		// SIGKILL only as the backstop for a truly wedged process.
		const wall = setTimeout(() => {
			child.kill('SIGTERM');
			setTimeout(() => child.kill('SIGKILL'), 15_000);
		}, PER_TAKE_WALL_MS);
		child.on('close', (code) => {
			clearTimeout(wall);
			const frozen = /=== frozen: (\S+)/.exec(out)?.[1] ?? null;
			const counts = /PASS (\d+) {2}FAIL (\d+) {2}INCONCLUSIVE (\d+)/.exec(out);
			const summary = counts
				? `PASS ${counts[1]} FAIL ${counts[2]} INCONCLUSIVE ${counts[3]}`
				: '(no report)';
			const ok = code === 0 && frozen !== null;
			resolve({
				ok,
				line: `${take.scenario}${take.defect ? `:${take.defect}` : ''}  exit=${code}  ${frozen ?? 'NO ARTIFACT'}  ${summary}`,
			});
		});
	});
}

async function main(): Promise<void> {
	const judge = process.argv.includes('--judge');
	const plan = parsePlan(process.argv.slice(2));
	if (plan.length === 0) throw new Error('empty plan');
	if (plan.length > MAX_TAKES) {
		throw new Error(`plan has ${plan.length} takes; the cap is ${MAX_TAKES} per invocation`);
	}
	console.log(`batch  : ${plan.length} take(s), per-take wall ${PER_TAKE_WALL_MS / 60000}min`);

	mkdirSync(join('data', 'live-sim', 'analysis'), { recursive: true });
	const logPath = join('data', 'live-sim', 'analysis', 'batch-log.txt');
	let consecutiveFailures = 0;
	const lines: string[] = [];
	for (const [i, take] of plan.entries()) {
		console.log(
			`take ${i + 1}/${plan.length}: ${take.scenario}${take.defect ? `:${take.defect}` : ''}`,
		);
		const r = await runTake(take, judge);
		lines.push(r.line);
		appendFileSync(logPath, `${new Date().toISOString()} ${r.line}\n`);
		console.log(`  ${r.line}`);
		consecutiveFailures = r.ok ? 0 : consecutiveFailures + 1;
		if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
			console.error(
				`parked : ${consecutiveFailures} consecutive failures — infrastructure is unwell; ` +
					'stopping the batch rather than burning the plan against it.',
			);
			break;
		}
		await new Promise((r2) => setTimeout(r2, 3000));
	}
	console.log('\nbatch summary:');
	for (const l of lines) console.log(`  ${l}`);
}

main().catch((e: unknown) => {
	console.error(e instanceof Error ? e.message : e);
	process.exit(1);
});
