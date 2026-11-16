// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Pure install planning for the data-driven runtime installer. From one runtime descriptor and the names of the
 * Ultrathink skills and commands in the clone it resolves the runtime's config root and lists every file an install
 * writes: where it comes from, which form it is converted to and where it lands. Nothing here touches the file
 * system; the caller injects the one fact planning needs, whether a default config root already exists.
 *
 * How a layout maps the sources:
 * - `skills`: each skill becomes `<skillsDir>/<name>/SKILL.md` (only its SKILL.md is installed).
 * - `skills+commands`: skills as above, each command becomes `<commandsDir>/<name><suffix>`.
 * - `commands` and `workflows`: the runtime has no skills surface, so commands and skills both become
 *   `<commandsDir>/<name><suffix>`.
 *
 * Every planned path carries the `ultrathink-` prefix, so an install never writes a path GSD-Core or the user owns.
 */
import { isAbsolute, join, posix, resolve } from "node:path";
import type { RuntimeDescriptor } from "./types.ts";

/** Every path the installer creates carries this prefix. */
export const MANAGED_PREFIX = "ultrathink-";
/** Directory in the config root that holds the install manifest. */
const MANIFEST_DIR = "ultrathink-runtime";
/** Directory in the config root that keeps copies of files the installer displaced. */
export const BACKUP_DIR = "ultrathink-backups";
/** Clone directories the sources come from: skills are `<name>/SKILL.md`, commands are `<name>.md`. */
export const SKILL_SOURCE_DIR = "skills";
export const COMMAND_SOURCE_DIR = "commands";
export const SKILL_FILE = "SKILL.md";

const NAME_PATTERN = /^ultrathink-[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type InstallScope = "global" | "local";
export type EnvMap = Readonly<Record<string, string | undefined>>;

/** Names of the Ultrathink artifacts present in the clone, such as `ultrathink-plan`. */
export interface SourceInventory {
	readonly skills: readonly string[];
	readonly commands: readonly string[];
}

export interface PlanContext {
	/** Absolute path of the Ultrathink clone the sources are read from. */
	readonly cloneRoot: string;
	readonly home: string;
	/** Workspace directory: a local install lands in a config root below it. */
	readonly cwd: string;
	readonly env: EnvMap;
	readonly scope: InstallScope;
	readonly sources: SourceInventory;
	/** Whether an absolute path is an existing directory; picks the first default config root that is. */
	readonly exists: (absolutePath: string) => boolean;
}

/** How a source file is rewritten: kept as a skill, rewritten as a Markdown command, or wrapped in a TOML command. */
export type ArtifactForm = "skill" | "markdown" | "toml";

export interface FileOp {
	readonly form: ArtifactForm;
	/** Source path relative to the clone, "/" separated. */
	readonly source: string;
	readonly sourcePath: string;
	/** Destination relative to the config root, "/" separated. */
	readonly path: string;
	readonly target: string;
}

export interface InstallPlan {
	readonly runtime: string;
	readonly scope: InstallScope;
	/** Absolute config root the install writes into. */
	readonly configRoot: string;
	readonly manifestDir: string;
	/** Sorted by `path`. */
	readonly ops: readonly FileOp[];
}

interface Failure {
	readonly ok: false;
	readonly error: string;
}

type PlanResult = { readonly ok: true; readonly plan: InstallPlan } | Failure;

/** True for an Ultrathink artifact name such as `ultrathink-plan`; the installer's own directories are not one. */
export function isManagedName(name: string): boolean {
	return NAME_PATTERN.test(name) && name !== MANIFEST_DIR && name !== BACKUP_DIR;
}

export function planInstall(descriptor: RuntimeDescriptor, ctx: PlanContext): PlanResult {
	const root = resolveConfigRoot(descriptor, ctx);
	if (!root.ok) return root;
	const dirs = layoutDirs(descriptor);
	if (!dirs.ok) return dirs;

	for (const name of [...ctx.sources.skills, ...ctx.sources.commands]) {
		if (!isManagedName(name)) return fail(`source "${name}" is not an ultrathink-* artifact name`);
	}
	const suffixForm: ArtifactForm = descriptor.commandSuffix === ".toml" ? "toml" : "markdown";
	const ops: FileOp[] = [];
	const add = (form: ArtifactForm, source: string, path: string): void => {
		ops.push({
			form,
			source,
			sourcePath: join(ctx.cloneRoot, source),
			path,
			target: join(root.root, path),
		});
	};

	for (const name of ctx.sources.skills) {
		const source = posix.join(SKILL_SOURCE_DIR, name, SKILL_FILE);
		if (dirs.skills !== undefined) {
			add("skill", source, posix.join(dirs.skills, name, SKILL_FILE));
		} else if (dirs.commands !== undefined) {
			add(suffixForm, source, posix.join(dirs.commands, `${name}${descriptor.commandSuffix}`));
		}
	}
	for (const name of ctx.sources.commands) {
		if (dirs.commands !== undefined) {
			const source = posix.join(COMMAND_SOURCE_DIR, `${name}.md`);
			add(suffixForm, source, posix.join(dirs.commands, `${name}${descriptor.commandSuffix}`));
		}
	}

	ops.sort((left, right) => compare(left.path, right.path));
	for (let index = 1; index < ops.length; index++) {
		const previous = ops[index - 1];
		const op = ops[index];
		if (previous !== undefined && op !== undefined && previous.path === op.path) {
			return fail(`${op.source} and ${previous.source} both install to ${op.path}`);
		}
	}

	return {
		ok: true,
		plan: {
			runtime: descriptor.id,
			scope: ctx.scope,
			configRoot: root.root,
			manifestDir: join(root.root, MANIFEST_DIR),
			ops,
		},
	};
}

function fail(error: string): Failure {
	return { ok: false, error };
}

function compare(left: string, right: string): number {
	if (left === right) return 0;
	return left < right ? -1 : 1;
}

/** Where a descriptor default points: `~`-relative or absolute is global, a relative path is a workspace root. */
function classify(entry: string): "global" | "workspace" | "invalid" {
	if (entry === "~" || entry.startsWith("~/") || isAbsolute(entry)) return "global";
	return entry === "" || entry.startsWith("~") ? "invalid" : "workspace";
}

function expandHome(value: string, home: string): string {
	if (value === "~") return home;
	return value.startsWith("~/") ? join(home, value.slice(2)) : value;
}

/**
 * Global scope: the first env var that is set, else the first default that exists, else the first default.
 * Local scope: the first workspace-relative default, resolved against the workspace; env vars never apply.
 */
function resolveConfigRoot(
	descriptor: RuntimeDescriptor,
	ctx: PlanContext,
): { readonly ok: true; readonly root: string } | Failure {
	const { id, configRoot } = descriptor;
	for (const entry of configRoot.defaults) {
		if (classify(entry) === "invalid") return fail(`${id}: unsupported config root "${entry}"`);
	}
	if (ctx.scope === "local") {
		if (descriptor.scope === "global") {
			return fail(`${id} installs globally only; run without --local`);
		}
		const entry = configRoot.defaults.find((candidate) => classify(candidate) === "workspace");
		if (entry === undefined) return fail(`${id} declares no workspace config root`);
		return { ok: true, root: resolve(ctx.cwd, entry) };
	}
	if (descriptor.scope === "workspace") {
		return fail(`${id} installs into a workspace only; run with --local`);
	}
	for (const name of configRoot.env) {
		const value = ctx.env[name]?.trim();
		if (value) return { ok: true, root: resolve(ctx.cwd, expandHome(value, ctx.home)) };
	}
	const globals = configRoot.defaults
		.filter((candidate) => classify(candidate) === "global")
		.map((candidate) => resolve(expandHome(candidate, ctx.home)));
	const root = globals.find((candidate) => ctx.exists(candidate)) ?? globals[0];
	return root === undefined ? fail(`${id} declares no global config root`) : { ok: true, root };
}

/** The skills and commands directories the descriptor's layout needs, checked to stay inside the config root. */
function layoutDirs(
	descriptor: RuntimeDescriptor,
): { readonly ok: true; readonly skills?: string; readonly commands?: string } | Failure {
	const wantsSkills = descriptor.layout === "skills" || descriptor.layout === "skills+commands";
	const wantsCommands = descriptor.layout !== "skills";
	const skills = wantsSkills
		? relativeDir(descriptor.id, "skillsDir", descriptor.skillsDir)
		: undefined;
	if (typeof skills === "object") return skills;
	const commands = wantsCommands
		? relativeDir(descriptor.id, "commandsDir", descriptor.commandsDir)
		: undefined;
	if (typeof commands === "object") return commands;
	return { ok: true, skills, commands };
}

function relativeDir(id: string, field: string, value: string | undefined): string | Failure {
	if (value === undefined) return fail(`${id}: its layout needs ${field}`);
	const dir = posix.normalize(value).replace(/\/+$/, "");
	if (
		dir === "" ||
		dir === "." ||
		dir === ".." ||
		dir.startsWith("../") ||
		isAbsolute(dir) ||
		dir.includes("\\")
	) {
		return fail(`${id}: ${field} "${value}" must be a relative path inside the config root`);
	}
	return dir;
}
