// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * The `--max-calls` safety of the live engine, enforced where a request is made. The real Claude completer retries a
 * transient failure inside one `engine.complete` call (up to three `claude -p` runs), so a counter around that call
 * cannot bound what the operator spends. The gate stands in for the `claude` binary instead: every run of it, retries
 * included, takes one numbered slot with an exclusive create, and a run past the cap is refused as a usage limit (a
 * permanent failure the retry does not repeat). The slots live in one directory, so concurrent flights share the cap.
 */
import {
	closeSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Names the gate directory for the shim; the one variable the real completer's child inherits from this process. */
export const GATE_DIR_ENV = "ULTRATHINK_CHAOS_GATE_DIR";

const SLOT_PREFIX = "slot-";
const REFUSED_FILE = "refused";
const SETTINGS_FILE = "gate.json";
const SHIM_PATH = fileURLToPath(new URL("./gate-shim.ts", import.meta.url));

/** The refusal the shim prints: "usage limit" is a permanent failure to the retry classifier, so nothing retries it. */
export const GATE_REFUSAL =
	"chaos: usage limit reached: --max-calls spent, no further request was made";

export interface GateSettings {
	cap: number;
	bin: string;
}

export interface CallGate {
	/** The executable to configure as `claude.bin` in place of the real one. */
	readonly shim: string;
	readonly dir: string;
	readonly cap: number;
	/** Requests that took a slot, which is the number actually sent to the real binary. */
	used(): number;
	/** True once a request was refused because every slot was taken. */
	refused(): boolean;
	/** Points this process (and the children it spawns) at the gate; returns the undo. */
	install(): () => void;
	dispose(): void;
}

/** Takes the next slot of the gate in `dir`. False, and the refusal recorded, when all `cap` slots are taken. */
export function claimAttempt(dir: string, cap: number): boolean {
	for (let slot = 1; slot <= cap; slot++) {
		try {
			closeSync(openSync(join(dir, `${SLOT_PREFIX}${slot}`), "wx", 0o600));
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
	}
	writeFileSync(join(dir, REFUSED_FILE), "");
	return false;
}

/** The real binary and the cap, as the shim reads them from the directory named by {@link GATE_DIR_ENV}. */
export function readGateSettings(dir: string): GateSettings {
	const parsed: unknown = JSON.parse(readFileSync(join(dir, SETTINGS_FILE), "utf8"));
	if (typeof parsed !== "object" || parsed === null)
		throw new Error("gate settings are not an object");
	const { cap, bin } = parsed as Record<string, unknown>;
	if (
		typeof cap !== "number" ||
		!Number.isSafeInteger(cap) ||
		cap < 0 ||
		typeof bin !== "string" ||
		bin === ""
	) {
		throw new Error("gate settings are malformed");
	}
	return { cap, bin };
}

/** A gate for `cap` requests to `bin`, in its own private directory. `shim` overrides the executable (tests only). */
export function createCallGate(opts: { cap: number; bin: string; shim?: string }): CallGate {
	const dir = mkdtempSync(join(tmpdir(), "chaos-gate-"));
	const settings: GateSettings = { cap: opts.cap, bin: opts.bin };
	writeFileSync(join(dir, SETTINGS_FILE), JSON.stringify(settings), { mode: 0o600 });
	return {
		shim: opts.shim ?? SHIM_PATH,
		dir,
		cap: opts.cap,
		used: () => readdirSync(dir).filter((name) => name.startsWith(SLOT_PREFIX)).length,
		refused: () => readdirSync(dir).includes(REFUSED_FILE),
		install: () => {
			const previous = process.env[GATE_DIR_ENV];
			process.env[GATE_DIR_ENV] = dir;
			return () => {
				if (previous === undefined) delete process.env[GATE_DIR_ENV];
				else process.env[GATE_DIR_ENV] = previous;
			};
		},
		dispose: () => rmSync(dir, { recursive: true, force: true }),
	};
}
