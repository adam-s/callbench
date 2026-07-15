import { existsSync, readFileSync, rmSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { DEBUG, DEBUG_DIR } from '../debug.ts';

// Force the logger on regardless of NODE_ENV; vitest sets NODE_ENV=test which
// disables it by default.
beforeAll(() => {
	process.env.DEBUG_LOGGING = 'true';
});

afterAll(() => {
	delete process.env.DEBUG_LOGGING;
});

afterEach(() => {
	vi.useRealTimers();
});

describe('DEBUG logger', () => {
	it('writes a cyan-wrapped line to stdout AND a matching line to the daily log file', async () => {
		const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		try {
			DEBUG('contract-stdout', 'roundtrip', () => ({ marker: 'abc-123' }));

			const calls = logSpy.mock.calls.map((c) => String(c[0]));
			const cyan = calls.find((c) => c.includes('\x1b[36m') && c.includes('abc-123'));
			expect(cyan, 'expected cyan-wrapped console.log call').toBeDefined();
		} finally {
			logSpy.mockRestore();
		}

		const today = new Date().toISOString().split('T')[0];
		const filePath = `${DEBUG_DIR}/debug-${today}.log`;
		// appendFile is async (callback form); give it a tick.
		await new Promise<void>((r) => setTimeout(r, 50));
		expect(existsSync(filePath)).toBe(true);
		const contents = readFileSync(filePath, 'utf-8');
		expect(contents).toContain('contract-stdout');
		expect(contents).toContain('abc-123');
	});

	// Regression (inherited from the sibling repo this module came from):
	// debug.ts used to compute new Date() twice — once for the line stamp and
	// once for the filename. At a midnight rollover the line could land in the
	// next day's file with the previous day's stamp. We pin both deriving from
	// the SAME instant, and verify the stdout line *and* the file written. An
	// earlier version of this test only checked stdout, which an implementation
	// writing the right timestamp to the wrong daily file would still pass.
	it('derives line timestamp and filename from the same Date instance', async () => {
		// Pick a unique fake date well in the past — guarantees the resulting
		// debug-YYYY-MM-DD.log does not exist yet, so we can verify the logger
		// created it (proving the derivation actually drove I/O).
		const fakeNow = new Date('2020-01-15T23:59:59.999Z');
		const expectedDate = fakeNow.toISOString().split('T')[0];
		const filePath = `${DEBUG_DIR}/debug-${expectedDate}.log`;
		rmSync(filePath, { force: true });

		vi.useFakeTimers();
		vi.setSystemTime(fakeNow);

		const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		try {
			DEBUG('midnight-derive', 'edge', () => ({ ok: 1 }));
			const stdout = String(logSpy.mock.calls.at(-1)?.[0] ?? '');
			const ansiPattern = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;]*m`, 'g');
			const stripped = stdout.replace(ansiPattern, '');
			const match = stripped.match(/^\[([^\]]+)\]/);
			expect(match, 'line should start with [ISO_TIMESTAMP]').toBeTruthy();
			const lineDate = (match?.[1] ?? '').split('T')[0];
			expect(lineDate).toBe(expectedDate);
		} finally {
			logSpy.mockRestore();
		}

		// Switch off fake timers BEFORE awaiting setTimeout, otherwise the
		// promise never resolves.
		vi.useRealTimers();
		await new Promise<void>((r) => setTimeout(r, 50));

		// File assertion: the line must be in the daily file derived from the
		// same instant. An implementation that printed the right timestamp but
		// wrote to a different filename would fail this.
		expect(existsSync(filePath), `expected log file at ${filePath}`).toBe(true);
		const contents = readFileSync(filePath, 'utf-8');
		expect(contents).toContain('midnight-derive');
		expect(contents).toContain(expectedDate);
		rmSync(filePath, { force: true });
	});

	// Regression: a dirCreated cache used to permanently disable file logging if
	// DEBUG_DIR was reaped. ensureDir now rechecks on every call. This matters
	// more here than in the repo it came from — a call runs for minutes and the
	// reaper firing mid-call would silently drop the rest of the diagnostics.
	it('recreates the log dir if it gets removed mid-run', async () => {
		const today = new Date().toISOString().split('T')[0];
		const filePath = `${DEBUG_DIR}/debug-${today}.log`;

		DEBUG('reaper-pre', 'before reap');
		await new Promise<void>((r) => setTimeout(r, 30));
		expect(existsSync(filePath)).toBe(true);

		// Simulate the macOS tmp reaper.
		rmSync(DEBUG_DIR, { recursive: true, force: true });
		expect(existsSync(DEBUG_DIR)).toBe(false);

		const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		try {
			DEBUG('reaper-post', 'after reap');
		} finally {
			logSpy.mockRestore();
		}

		await new Promise<void>((r) => setTimeout(r, 30));
		expect(existsSync(DEBUG_DIR), 'logger should recreate the dir').toBe(true);
		expect(existsSync(filePath), 'logger should rewrite to a fresh log file').toBe(true);
	});

	// The off-switch is load-bearing: a lazy factory that runs anyway would
	// make debug logging cost real work inside the call's hot path.
	it('does not invoke the data factory when disabled', () => {
		process.env.DEBUG_LOGGING = 'false';
		const factory = vi.fn(() => ({ expensive: true }));
		const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		try {
			DEBUG('off-mode', 'should not log', factory);
			expect(factory).not.toHaveBeenCalled();
			expect(logSpy).not.toHaveBeenCalled();
		} finally {
			logSpy.mockRestore();
			process.env.DEBUG_LOGGING = 'true';
		}
	});

	// A throwing factory must not take down the caller. During a live call the
	// caller is the media loop, and an exception there ends a real phone call
	// over a log line.
	it('survives a throwing data factory and records the error', async () => {
		const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		try {
			expect(() =>
				DEBUG('throwing-factory', 'boom', () => {
					throw new Error('factory-exploded');
				}),
			).not.toThrow();
			const line = String(logSpy.mock.calls.at(-1)?.[0] ?? '');
			expect(line).toContain('factory-exploded');
		} finally {
			logSpy.mockRestore();
		}
		await new Promise<void>((r) => setTimeout(r, 30));
	});
});
