// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Shared shapes for `ultrathink doctor`: a finding, the report built from findings, and the side-effect seams every
 * check receives. Imports nothing, so each check module and the report can depend on it. Doctor is static and offline,
 * except the `stack` section (stack-check.ts), which makes the free read-only probe requests; nothing starts `gh` or `curl`.
 */

const DOCTOR_LEVELS = ["ok", "info", "warn", "error"] as const;
export type DoctorLevel = (typeof DOCTOR_LEVELS)[number];

/** Report order of the sections. */
export const DOCTOR_SECTIONS = [
	"runtime",
	"config",
	"credentials",
	"env",
	"inference",
	"state",
	"memory",
	"pstack",
	"stack",
] as const;
export type DoctorSection = (typeof DOCTOR_SECTIONS)[number];

export interface Finding {
	/** Stable, dotted identifier such as `config.project.unknown-key.ship.autoMerg`. */
	id: string;
	section: DoctorSection;
	level: DoctorLevel;
	title: string;
	detail?: string;
	fix?: string;
}

export interface DoctorReport {
	/** True when no finding has level `error`. */
	ok: boolean;
	summary: Record<DoctorLevel, number>;
	findings: Finding[];
}

type Env = Record<string, string | undefined>;

/** The only executables doctor ever starts, each with `--version`. */
export const PYTHON_COMMANDS = ["python3", "python"] as const;
export type PythonCommand = (typeof PYTHON_COMMANDS)[number];

/**
 * Every side effect a check performs. The config, credential and state locations all derive from `env` and `cwd`, so a
 * test points them at a temp directory instead of replacing the filesystem.
 */
export interface DoctorDeps {
	env: Env;
	cwd: string;
	now: () => number;
	/** Absolute path of an executable on `PATH`, or undefined. */
	which: (command: string) => string | undefined;
	/** Version string of the running Bun, for example `1.2.19`. */
	bunVersion: string;
	/** First line of `<command> --version`, or undefined when it cannot be run. Only the Python interpreters are ever probed: `gh` and `curl` cannot be passed. */
	runVersion: (command: PythonCommand) => string | undefined;
	/** First line of `<bin> --version` for the configured `claude.bin` (sync, 8 s cap), or undefined when it cannot run. Optional: absent means the version finding is skipped. */
	claudeVersion?: (bin: string) => string | undefined;
	/** Stdout of `<bin> auth status --json` run with `env` (sync, 8 s cap), or undefined when it cannot run. Optional: absent means the auth finding is skipped. */
	claudeAuth?: (env: Env, bin: string) => string | undefined;
}
