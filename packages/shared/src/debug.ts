/**
 * Unified DEBUG logging — writes to both console (cyan) and file.
 *
 * All DEBUG() calls converge on /tmp/callbench-debug/debug-YYYY-MM-DD.log so
 * logs from the runner, the transport, and the speech adapters can be cat'd
 * together and sorted chronologically (ISO timestamp is the first token of
 * every line). During a call the components run concurrently and the
 * interleaving IS the diagnostic — a per-component log would hide it.
 *
 * Enabled by default in development. Disabled in production and test.
 * Override with DEBUG_LOGGING=true or DEBUG_LOGGING=false.
 *
 * Data is computed lazily — pass a factory function, not an object:
 *   DEBUG('location', 'message', () => ({ key: expensiveCall() }))
 *
 * This logger is for the harness's own behavior. It is NOT the timing source:
 * a latency figure needs both endpoints stamped from one clock at one layer,
 * and a log line is neither (see AGENTS.md). Nor is it the transcript — that
 * is an append-only, hashed artifact, not a debug stream.
 *
 * Logging a live call is logging a conversation. Redact scenario-supplied fake
 * identity (names, numbers, payment strings) at the call site, not at the
 * reader's discretion.
 */

import { appendFile, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const DEBUG_DIR = '/tmp/callbench-debug';

// Recomputed on every DEBUG() call — the contract is that one running process
// can be toggled without recompile or restart, and a module-load snapshot
// would freeze the value at import time. A call runs for minutes; being able
// to toggle mid-call is the point.
function isDebugEnabled(): boolean {
	const env = globalThis.process?.env;
	if (env?.DEBUG_LOGGING === 'true') return true;
	if (env?.DEBUG_LOGGING === 'false') return false;
	return env?.NODE_ENV !== 'production' && env?.NODE_ENV !== 'test';
}

type DataFactory = () => Record<string, unknown>;

// Recheck on every call (no cache): macOS's tmp reaper can delete DEBUG_DIR
// mid-run, and a cached "dirCreated" flag would silently disable file logging
// until restart. mkdirSync with recursive is a no-op when the dir exists.
function ensureDir(): void {
	if (!existsSync(DEBUG_DIR)) {
		mkdirSync(DEBUG_DIR, { recursive: true });
	}
}

export function DEBUG(message: string): void;
export function DEBUG(location: string, message: string): void;
export function DEBUG(location: string, dataFactory: DataFactory): void;
export function DEBUG(location: string, message: string, dataFactory: DataFactory): void;
export function DEBUG(arg1: string, arg2?: string | DataFactory, arg3?: DataFactory): void {
	if (!isDebugEnabled()) return;

	let location: string | undefined;
	let message: string;
	let dataFactory: DataFactory | undefined;

	if (typeof arg2 === 'function') {
		location = arg1;
		message = 'debug';
		dataFactory = arg2;
	} else if (typeof arg2 === 'string') {
		location = arg1;
		message = arg2;
		dataFactory = arg3;
	} else {
		message = arg1;
	}

	let data: Record<string, unknown> | undefined;
	if (dataFactory) {
		try {
			data = dataFactory();
		} catch (e) {
			data = { _error: (e as Error).message };
		}
	}

	// Compute timestamp once: the line content and the filename derive from the
	// SAME instant, so a log emitted at 23:59:59.999 can't land in the next
	// day's file with the previous day's stamp.
	const timestamp = new Date().toISOString();
	const date = timestamp.split('T')[0];
	const loc = location ? `[${location}] ` : '';
	const dataStr = data ? ` ${JSON.stringify(data)}` : '';
	const line = `[${timestamp}] [DEBUG] ${loc}${message}${dataStr}`;

	console.log(`\x1b[36m${line}\x1b[0m`);

	try {
		ensureDir();
		const file = join(DEBUG_DIR, `debug-${date}.log`);
		appendFile(file, `${line}\n`, () => {});
	} catch {
		// Silently fail file writes. A logging failure must never end a live
		// call — the call costs somebody's phone line, the log doesn't.
	}
}
