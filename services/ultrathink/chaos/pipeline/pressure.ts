// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { availableParallelism } from "node:os";

export interface PressureSpec {
	/** Busy threads. 0 is a valid no-op. Default: one per available CPU. */
	workers?: number;
	/** Share of each 10 ms slice a worker spins, 0 to 1. Default 1 (saturate). */
	duty?: number;
	/** Memory ballast in MiB, touched and held until stop. Default 0. */
	memMB?: number;
	/** Hard self-deadline of every worker in milliseconds, whatever the caller does. Default 30000. */
	maxMs?: number;
}

interface PressureReading {
	/** Process CPU (user plus system, workers included) since the helper started. */
	cpuMs: number;
	wallMs: number;
	/** cpuMs over wallMs: 1 is one core fully busy. 0 when no time has passed. */
	ratio: number;
	/** Worst event-loop timer drift seen while workers ran. */
	stallMaxMs: number;
}

export interface Pressure {
	/** What the host actually gave: the run is judged on this, not on what was asked for. */
	achieved(): PressureReading;
	stop(): Promise<void>;
	ballastBytes(): number;
}

interface PressureWorker {
	postMessage(message: unknown): void;
	terminate(): unknown;
}

interface PressureSeams {
	now?: () => number;
	/** Process CPU in microseconds. */
	cpuNow?: () => { user: number; system: number };
	spawnWorker?: () => PressureWorker;
	timers?: {
		setInterval(callback: () => void, ms: number): unknown;
		clearInterval(handle: unknown): void;
	};
}

const SLICE_MS = 10;
const DEFAULT_MAX_MS = 30_000;
const MAX_WORKERS = 256;
const MAX_MEM_MB = 4096;

// Spins `duty` of every 10 ms slice and waits out the rest on a shared cell, until the stop flag or the self-deadline.
// An inline Blob: no extra file, no dependency. Cell 0 is only ever waited on; cell 1 is the stop flag.
const WORKER_SOURCE = `
self.onmessage = (event) => {
	const { sab, duty, maxMs } = event.data;
	const flags = new Int32Array(sab);
	const end = performance.now() + maxMs;
	const on = duty * ${SLICE_MS};
	const off = ${SLICE_MS} - on;
	while (Atomics.load(flags, 1) === 0 && performance.now() < end) {
		const sliceStart = performance.now();
		while (performance.now() - sliceStart < on) {}
		if (off > 0) Atomics.wait(flags, 0, 0, off);
	}
	self.postMessage("done");
};
`;

function integer(value: number, name: string, max: number): number {
	if (!Number.isInteger(value) || value < 0 || value > max) {
		throw new RangeError(`${name} must be an integer between 0 and ${max}`);
	}
	return value;
}

/**
 * Starts CPU, memory and timer-drift pressure for a load run. CLI soak only: a unit test with `workers: 0` gets a no-op
 * that spawns nothing. `achieved()` is process CPU over wall time since the start, so a host that is already loaded
 * reports what it really delivered, and the caller fails the run when that is under its floor.
 */
export function startPressure(spec: PressureSpec = {}, seams: PressureSeams = {}): Pressure {
	const workers = integer(spec.workers ?? availableParallelism(), "workers", MAX_WORKERS);
	const duty = Math.min(1, Math.max(0, spec.duty ?? 1));
	const memMB = integer(spec.memMB ?? 0, "memMB", MAX_MEM_MB);
	const maxMs = spec.maxMs ?? DEFAULT_MAX_MS;
	const now = seams.now ?? (() => performance.now());
	const cpuNow = seams.cpuNow ?? (() => process.cpuUsage());
	const timers = seams.timers ?? {
		setInterval: (callback, ms) => setInterval(callback, ms),
		clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
	};

	const startWall = now();
	const startCpu = cpuNow();
	let ballast: Buffer | undefined = memMB > 0 ? Buffer.alloc(memMB * 1024 * 1024, 1) : undefined;
	let stallMax = 0;
	let stopped = false;
	let frozen: PressureReading | undefined;

	const flags = workers > 0 ? new Int32Array(new SharedArrayBuffer(8)) : undefined;
	let blobUrl: string | undefined;
	let spawn = seams.spawnWorker;
	if (workers > 0 && spawn === undefined) {
		const url = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: "text/javascript" }));
		blobUrl = url;
		spawn = () => new Worker(url);
	}
	const running: PressureWorker[] = [];
	if (flags !== undefined && spawn !== undefined) {
		for (let i = 0; i < workers; i += 1) {
			const worker = spawn();
			worker.postMessage({ sab: flags.buffer, duty, maxMs });
			running.push(worker);
		}
	}

	let sampler: unknown;
	if (workers > 0) {
		let last = now();
		sampler = timers.setInterval(() => {
			const at = now();
			stallMax = Math.max(stallMax, at - last - SLICE_MS);
			last = at;
		}, SLICE_MS);
	}

	const read = (): PressureReading => {
		const cpu = cpuNow();
		const cpuMs = (cpu.user + cpu.system - startCpu.user - startCpu.system) / 1000;
		const wallMs = now() - startWall;
		return { cpuMs, wallMs, ratio: wallMs > 0 ? cpuMs / wallMs : 0, stallMaxMs: stallMax };
	};

	return {
		achieved: () => frozen ?? read(),
		ballastBytes: () => ballast?.length ?? 0,
		stop: async () => {
			if (stopped) return;
			stopped = true;
			frozen = read();
			if (flags !== undefined) {
				Atomics.store(flags, 1, 1);
				Atomics.notify(flags, 0);
			}
			if (sampler !== undefined) timers.clearInterval(sampler);
			await Promise.all(running.map((worker) => worker.terminate()));
			if (blobUrl !== undefined) URL.revokeObjectURL(blobUrl);
			ballast = undefined;
		},
	};
}

interface PressureCommand {
	workers: number;
	seconds: number;
	memoryMb?: number;
	/** The CPU ratio the host must deliver for the pressure to count as applied. Default 0.5. */
	floor?: number;
}

interface PressureCommandDeps {
	startPressure?: (spec: PressureSpec) => Pressure;
	stdout: (text: string) => void;
	stderr: (text: string) => void;
	/** Waits out the hold. Default: the platform timer. */
	sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_FLOOR = 0.5;
const MAX_HOLD_SECONDS = 3600;
// The workers outlive the hold by a second, so a slow stop never races their own deadline.
const HOLD_MARGIN_MS = 1000;

function platformSleep(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

function formatNumber(value: number): string {
	return String(Math.round(value * 10_000) / 10_000);
}

/**
 * Holds full-duty pressure for `seconds` so a soak loop can run beside it, then reports what the host delivered. Exit 0
 * when the achieved CPU ratio met the floor; 2 with "pressure not applied" when it did not. The helper is always stopped.
 */
export async function runPressureCommand(
	spec: PressureCommand,
	deps: PressureCommandDeps,
): Promise<number> {
	integer(spec.workers, "workers", MAX_WORKERS);
	if (spec.workers < 1) throw new RangeError("workers must be at least 1");
	integer(spec.seconds, "seconds", MAX_HOLD_SECONDS);
	if (spec.seconds < 1) throw new RangeError("seconds must be at least 1");
	const floor = spec.floor ?? DEFAULT_FLOOR;
	if (!Number.isFinite(floor) || floor < 0)
		throw new RangeError("floor must be a non-negative number");
	const pressure = (deps.startPressure ?? startPressure)({
		workers: spec.workers,
		duty: 1,
		memMB: spec.memoryMb ?? 0,
		maxMs: spec.seconds * 1000 + HOLD_MARGIN_MS,
	});
	try {
		await (deps.sleep ?? platformSleep)(spec.seconds * 1000);
	} finally {
		await pressure.stop();
	}
	const reading = pressure.achieved();
	deps.stdout(
		`pressure held ${spec.seconds}s: cpuMs ${formatNumber(reading.cpuMs)} wallMs ${formatNumber(reading.wallMs)} ratio ${formatNumber(reading.ratio)}\n`,
	);
	if (reading.ratio < floor) {
		deps.stderr(
			`pressure not applied: achieved CPU ratio ${formatNumber(reading.ratio)} is below the floor ${formatNumber(floor)}\n`,
		);
		return 2;
	}
	return 0;
}
