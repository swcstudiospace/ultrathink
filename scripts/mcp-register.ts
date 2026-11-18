// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
// Register the central ultrathink MCP gateway (notion, linear, greptile) in every host's user config.
// Usage: see USAGE below (`bun scripts/mcp-register.ts --help`).
import { constants, copyFileSync, existsSync, readFileSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { errorCode, writeFileAtomic } from "../src/claude/atomic.ts";
import { isRecord } from "../src/shared.ts";

const HOSTS = ["claude", "grok", "hermes", "muse", "omp"] as const;
type Host = (typeof HOSTS)[number];
/** MCP servers only: API-key providers such as openrouter are never registered with a host. */
export const PROVIDER_IDS = ["notion", "linear", "greptile"] as const;

const USAGE = `Usage: bun scripts/mcp-register.ts [--hosts claude,grok,hermes,muse,omp] [--providers notion,linear,greptile] [--replace | --remove] [--dry-run]

Registers notion, linear and greptile entries that run <clone>/bin/ultrathink-mcp serve <provider>
in each host's user config. Every file it changes is backed up as <file>.bak-ultrathink-mcp-<timestamp>.

  --hosts      hosts to change (default: all)
  --providers  providers to register or remove (default: all)
  --replace    also overwrite same-named entries that are not ultrathink's (by default they are kept)
  --remove     delete ultrathink's entries (command ends with /bin/ultrathink-mcp); other entries are kept
  --dry-run    print what would change without writing a file or changing a host (the hosts' read-only list/get commands still run)`;

export interface Entry {
	id: string;
	command: string;
	args: string[];
}

export type Mode = "add" | "replace" | "remove";

type Action =
	| "added"
	| "replaced"
	| "re-enabled"
	| "unchanged"
	| "kept"
	| "removed"
	| "not registered"
	| "saved disabled"
	| "FAILED";

export interface Change {
	id: string;
	action: Action;
	reason?: string;
}

export interface MergeResult {
	next: Record<string, unknown>;
	changes: Change[];
}

interface RunResult {
	code: number;
	stdout: string;
	stderr: string;
}

export type Run = (cmd: string[], options?: { stdin?: string; timeoutMs?: number }) => RunResult;

export type CliHost = "claude" | "grok" | "hermes";

export interface Plan {
	commands: string[][];
	changes: Change[];
}

export interface PlanOptions {
	mode?: Mode;
	/** Reads Hermes' config.yaml (fresh on every call); undefined when it is missing. Throws HostConfigError when it is unreadable. */
	hermesConfig?: () => string | undefined;
	/** Reads Claude Code's ~/.claude.json (fresh on every call), whose top-level mcpServers is the user scope. */
	claudeConfig?: () => string | undefined;
}

/** A host's config file exists but cannot be read: planning for that host stops, and the message is reported. */
class HostConfigError extends Error {}

/** What a host holds under one server name. `ours` is false whenever ownership cannot be determined. */
interface Found {
	present: boolean;
	ours: boolean;
	matches: boolean;
	disabled: boolean;
	/** Why a same-named entry in another scope was ignored; reported when the decision has no reason of its own. */
	note?: string;
}

type Json = Record<string, unknown>;

const OURS_SUFFIX = "/bin/ultrathink-mcp";
const KEPT_ON_ADD = "existing entry is not ultrathink's; rerun with --replace to overwrite it";
const KEPT_ON_REMOVE = "existing entry is not ultrathink's; left in place";
const ABSENT: Found = { present: false, ours: false, matches: false, disabled: false };
const UNKNOWN: Found = { present: true, ours: false, matches: false, disabled: false };
// Actions that run host commands (and are verified afterwards).
const ACTING: Partial<Record<Action, true>> = {
	added: true,
	replaced: true,
	"re-enabled": true,
	removed: true,
};

function sameJson(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

/** An entry is ultrathink's when its command is some clone's bin/ultrathink-mcp. */
function isOurs(command: unknown): boolean {
	return typeof command === "string" && command.trim().endsWith(OURS_SUFFIX);
}

function decide(id: string, found: Found, mode: Mode): Change {
	if (mode === "remove") {
		if (!found.present) return { id, action: "not registered" };
		return found.ours ? { id, action: "removed" } : { id, action: "kept", reason: KEPT_ON_REMOVE };
	}
	if (found.matches && !found.disabled) return { id, action: "unchanged" };
	if (found.present && !found.ours && mode !== "replace")
		return { id, action: "kept", reason: KEPT_ON_ADD };
	if (found.disabled) return { id, action: "re-enabled", reason: "was disabled" };
	return { id, action: found.present ? "replaced" : "added" };
}

function mergeServers(
	current: unknown,
	entries: Entry[],
	shape: (entry: Entry) => Json,
	mode: Mode,
	legacyKey?: string,
): MergeResult {
	const next: Json = isRecord(current) ? { ...current } : {};
	let servers: Json = isRecord(next.mcpServers) ? { ...next.mcpServers } : {};
	if (legacyKey && isRecord(next[legacyKey])) {
		servers = { ...(next[legacyKey] as Json), ...servers };
		delete next[legacyKey];
	}
	const changes: Change[] = [];
	for (const entry of entries) {
		const wanted = shape(entry);
		const existing = servers[entry.id];
		const found: Found = {
			present: existing !== undefined,
			ours: isRecord(existing) && isOurs(existing.command),
			// Hosts may rewrite the file: key order changes and the default `type: "stdio"` can be dropped.
			matches:
				isRecord(existing) &&
				Object.keys(existing).every((key) => key in wanted) &&
				Object.entries(wanted).every(
					([key, value]) =>
						sameJson(existing[key], value) || (key === "type" && existing[key] === undefined),
				),
			disabled: false,
		};
		const change = decide(entry.id, found, mode);
		if (change.action === "added" || change.action === "replaced") servers[entry.id] = wanted;
		changes.push(change);
	}
	next.mcpServers = servers;
	return { next, changes };
}

// Deletes only ultrathink's entries, from mcpServers and (for Muse) the legacy key, without reshaping the file.
function removeServers(current: unknown, ids: string[], legacyKey?: string): MergeResult {
	const next: Json = isRecord(current) ? { ...current } : {};
	const keys = legacyKey ? ["mcpServers", legacyKey] : ["mcpServers"];
	const changes = ids.map((id): Change => {
		const holders = keys.filter((key) => {
			const servers = next[key];
			return isRecord(servers) && Object.hasOwn(servers, id);
		});
		const ours = holders.filter((key) => {
			const existing = (next[key] as Json)[id];
			return isRecord(existing) && isOurs(existing.command);
		});
		for (const key of ours) {
			const rest = { ...(next[key] as Json) };
			delete rest[id];
			next[key] = rest;
		}
		if (ours.length) return { id, action: "removed" };
		return holders.length
			? { id, action: "kept", reason: KEPT_ON_REMOVE }
			: { id, action: "not registered" };
	});
	return { next, changes };
}

export function mergeOmpMcp(current: unknown, entries: Entry[], mode: Mode = "add"): MergeResult {
	if (mode === "remove")
		return removeServers(
			current,
			entries.map((e) => e.id),
		);
	return mergeServers(
		current,
		entries,
		(e) => ({ type: "stdio", command: e.command, args: e.args }),
		mode,
	);
}

export function mergeMuseSettings(
	current: unknown,
	entries: Entry[],
	mode: Mode = "add",
): MergeResult {
	if (mode === "remove")
		return removeServers(
			current,
			entries.map((e) => e.id),
			"mcp_servers",
		);
	const base = isRecord(current) ? current : { schema_version: 1 };
	return mergeServers(
		base,
		entries,
		(e) => ({ type: "stdio", command: e.command, args: e.args, mode: "optional" }),
		mode,
		"mcp_servers",
	);
}

const CLI_COMMANDS: Record<
	CliHost,
	{ add: (entry: Entry) => string[][]; remove: (id: string) => string[][] }
> = {
	claude: {
		add: (e) => [
			["claude", "mcp", "remove", "--scope", "user", e.id],
			["claude", "mcp", "add", "--scope", "user", e.id, "--", e.command, ...e.args],
		],
		remove: (id) => [["claude", "mcp", "remove", "--scope", "user", id]],
	},
	grok: {
		add: (e) => [["grok", "mcp", "add", "--scope", "user", e.id, e.command, "--", ...e.args]],
		remove: (id) => [["grok", "mcp", "remove", "--scope", "user", id]],
	},
	hermes: {
		add: (e) => [
			["hermes", "mcp", "remove", e.id],
			["hermes", "mcp", "add", e.id, "--command", e.command, "--args", ...e.args],
		],
		remove: (id) => [["hermes", "mcp", "remove", id]],
	},
};

function planFrom(
	host: CliHost,
	entries: Entry[],
	find: (entry: Entry) => Found,
	mode: Mode,
): Plan {
	const plan: Plan = { commands: [], changes: [] };
	for (const entry of entries) {
		const found = find(entry);
		const change = decide(entry.id, found, mode);
		if (found.note && !change.reason) change.reason = found.note;
		plan.changes.push(change);
		if (change.action === "removed") plan.commands.push(...CLI_COMMANDS[host].remove(entry.id));
		else if (ACTING[change.action]) plan.commands.push(...CLI_COMMANDS[host].add(entry));
	}
	return plan;
}

// Reads one `Key: value` field from `claude mcp get` output: the first such line, or undefined when there is none.
function claudeField(text: string, key: string): string | undefined {
	return new RegExp(`^[ \\t]*${key}:[ \\t]*(.*?)\\s*$`, "m").exec(text)?.[1];
}

// add/remove act on the user scope only, so ownership comes from the user-scope entry alone.
// `claude mcp get <name>` exits non-zero when the name is unknown in every scope; otherwise it prints the entry that
// wins by precedence (local > project > user) with a `Scope:` line such as "User config (available in all your
// projects)". When another scope wins, the user-scope entry is read from ~/.claude.json's top-level mcpServers.
export function planClaude(run: Run, entries: Entry[], options: PlanOptions = {}): Plan {
	return planFrom(
		"claude",
		entries,
		(entry): Found => {
			const got = run(["claude", "mcp", "get", entry.id]);
			if (got.code !== 0) return ABSENT;
			const text = `${got.stdout}\n${got.stderr}`;
			const scope = /^\s*Scope:\s*(.+?)\s*$/m.exec(text)?.[1];
			if (scope === undefined || /^User config\b/i.test(scope)) {
				// Matched on the entry's own Command and Args lines; text elsewhere in the output proves nothing.
				const command = claudeField(text, "Command");
				const args = claudeField(text, "Args") ?? "";
				const matches = command === entry.command && args === entry.args.join(" ");
				return { present: true, ours: matches || isOurs(command), matches, disabled: false };
			}
			const note = `${scope.split(" (")[0]?.toLowerCase()} entry with this name is left alone`;
			let servers: Json | undefined;
			try {
				const parsed: unknown = JSON.parse(options.claudeConfig?.() ?? "");
				if (isRecord(parsed)) servers = isRecord(parsed.mcpServers) ? parsed.mcpServers : {};
			} catch {
				// reason: unparseable claude config is reported as UNKNOWN, not as an absent entry
				servers = undefined;
			}
			if (servers === undefined) return { ...UNKNOWN, note };
			const user = servers[entry.id];
			if (user === undefined) return { ...ABSENT, note };
			const command = isRecord(user) ? user.command : undefined;
			const args = isRecord(user) ? (user.args ?? []) : undefined;
			return {
				present: true,
				ours: isOurs(command),
				matches: command === entry.command && sameJson(args, entry.args),
				disabled: false,
				note,
			};
		},
		options.mode ?? "add",
	);
}

// `grok mcp list --json` prints an array of `{ name, command?, args?, url?, scope }` across scopes; only user-scope
// entries (or ones without a scope field) count. Unreadable output is UNKNOWN.
export function planGrok(run: Run, entries: Entry[], options: PlanOptions = {}): Plan {
	const listed = run(["grok", "mcp", "list", "--json"]);
	let servers: Json[] | undefined;
	try {
		const parsed: unknown = JSON.parse(listed.stdout);
		if (Array.isArray(parsed)) servers = parsed.filter(isRecord);
	} catch {
		// reason: unparseable grok list output is reported as UNKNOWN, not as an absent entry
		servers = undefined;
	}
	return planFrom(
		"grok",
		entries,
		(entry) => {
			if (!servers) return UNKNOWN;
			const named = servers.filter((s) => s.name === entry.id);
			const user = named.filter((s) => s.scope === undefined || s.scope === "user");
			const others = [
				...new Set(named.filter((s) => !user.includes(s)).map((s) => String(s.scope))),
			];
			const note = others.length
				? `${others.join(", ")}-scope entry with this name is left alone`
				: undefined;
			if (!user.length) return { ...ABSENT, note };
			return {
				present: true,
				ours: user.every((s) => isOurs(s.command)),
				matches: user.some(
					(s) => s.command === entry.command && sameJson(s.args ?? [], entry.args),
				),
				disabled: false,
				note,
			};
		},
		options.mode ?? "add",
	);
}

function unquote(value: string): string {
	const m = /^(['"])(.*)\1$/.exec(value);
	return m ? (m[2] ?? "") : value;
}

/**
 * Server name → `command` (undefined for url servers) from the `mcp_servers:` block of Hermes' config.yaml.
 * A small indentation-based reader for the block style Hermes writes; anything else simply yields no command.
 */
function hermesServerCommands(text: string): Map<string, string | undefined> {
	const found = new Map<string, string | undefined>();
	let inServers = false;
	let serverIndent = -1;
	let childIndent = -1;
	let current: string | undefined;
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;
		const indent = raw.length - raw.trimStart().length;
		if (indent === 0) {
			inServers = /^mcp_servers:\s*(#.*)?$/.test(line);
			serverIndent = -1;
			current = undefined;
			continue;
		}
		if (!inServers) continue;
		if (serverIndent < 0) serverIndent = indent;
		if (indent <= serverIndent) {
			const key = /^(.+?):\s*(#.*)?$/.exec(line)?.[1];
			current = indent === serverIndent && key !== undefined ? unquote(key) : undefined;
			if (current !== undefined) found.set(current, undefined);
			childIndent = -1;
			continue;
		}
		if (current === undefined) continue;
		if (childIndent < 0) childIndent = indent;
		if (indent !== childIndent) continue;
		const command = /^command:\s*(.+?)\s*$/.exec(line)?.[1];
		if (command !== undefined && found.get(current) === undefined)
			found.set(current, unquote(command));
	}
	return found;
}

/**
 * The config.yaml that `hermes mcp` edits, resolved the way Hermes' profile override does: a HERMES_HOME that is a
 * `<root>/profiles/<name>` directory is used as is; otherwise a non-default `active_profile` in the Hermes root
 * selects `profiles/<name>` under HERMES_HOME (or ~/.hermes). Undefined when that profile cannot be resolved, or when
 * active_profile exists but cannot be read; Hermes itself refuses to run with it.
 */
export function hermesConfigFile(
	env: Record<string, string | undefined>,
	home: string,
): string | undefined {
	const native = resolve(home, ".hermes");
	const envHome = env.HERMES_HOME?.trim() || undefined;
	if (envHome && basename(dirname(envHome)) === "profiles") return join(envHome, "config.yaml");
	const base = envHome ?? native;
	const envPath = envHome === undefined ? undefined : resolve(envHome);
	const root =
		envPath === undefined || envPath === native || envPath.startsWith(`${native}/`) ? native : base;
	let active = "";
	try {
		active = readFileSync(join(root, "active_profile"), "utf8").trim().toLowerCase();
	} catch (error) {
		// reason: a missing active_profile file is the normal case and selects the default profile; any other read failure
		// leaves the active profile unknown, so the Hermes target is refused rather than written to the default profile
		if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT")
			return undefined;
		active = "";
	}
	if (!active || active === "default") return join(base, "config.yaml");
	if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(active)) return undefined;
	const profile = join(base, "profiles", active);
	return existsSync(profile) ? join(profile, "config.yaml") : undefined;
}

// `hermes mcp list` rows are `<name>  <transport>  <tools>  <status>`; long transports are truncated with "...".
// A row's command is trusted only when config.yaml agrees with it (or, without a config entry, when the row is
// untruncated); a missing row, a url server or any disagreement between the two makes the entry foreign.
export function planHermes(run: Run, entries: Entry[], options: PlanOptions = {}): Plan {
	const lines = run(["hermes", "mcp", "list"])
		.stdout.split("\n")
		.map((line) => line.trim());
	const config = options.hermesConfig?.();
	const commands = config === undefined ? undefined : hermesServerCommands(config);
	return planFrom(
		"hermes",
		entries,
		(entry) => {
			const full = [entry.command, ...entry.args].join(" ");
			const named = lines.filter((line) => line.split(/\s+/)[0] === entry.id);
			const transports = named.map(
				(line) =>
					line
						.slice(entry.id.length)
						.trim()
						.split(/\s{2,}/)[0] ?? "",
			);
			const shown = named.filter((_, i) => {
				const transport = transports[i] ?? "";
				return transport.endsWith("...")
					? full.startsWith(transport.slice(0, -3))
					: transport === full;
			});
			// Status column is `✓ enabled` or `✗ disabled`; Hermes saves failed connection tests disabled.
			const disabled = shown.length > 0 && shown.every((line) => /\bdisabled\s*$/.test(line));
			const inConfig = commands?.has(entry.id) ?? false;
			const configured = commands?.get(entry.id);
			const ours =
				named.length > 0 &&
				!(inConfig && configured === undefined) &&
				transports.every((t) => {
					const truncated = t.endsWith("...");
					const text = truncated ? t.slice(0, -3) : t;
					if (configured === undefined) return !truncated && isOurs(text.split(/\s+/)[0]);
					const agrees =
						text === configured ||
						text.startsWith(`${configured} `) ||
						(truncated && configured.startsWith(text));
					return agrees && isOurs(configured);
				});
			return { present: named.length > 0 || inConfig, ours, matches: shown.length > 0, disabled };
		},
		options.mode ?? "add",
	);
}

function backupSuffix(date: Date): string {
	const p = (n: number) => String(n).padStart(2, "0");
	return `.bak-ultrathink-mcp-${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

/**
 * Copies `file` to `<file><stamp>`, or `<file><stamp>-2`, `-3`, ... when that name is taken, so an earlier
 * backup (the pristine one) is never overwritten by a second run in the same second.
 */
function backup(file: string, stamp: string, dryRun: boolean, log: (line: string) => void): void {
	if (!existsSync(file)) return;
	for (let n = 1; ; n++) {
		const dest = n === 1 ? `${file}${stamp}` : `${file}${stamp}-${n}`;
		if (dryRun) {
			if (existsSync(dest)) continue;
		} else {
			try {
				copyFileSync(file, dest, constants.COPYFILE_EXCL);
			} catch (error) {
				if (errorCode(error) === "EEXIST") continue;
				throw error;
			}
		}
		log(`  backup ${file} -> ${dest}`);
		return;
	}
}

/** The file's text, or undefined when it does not exist; any other read error is rethrown. */
function readRaw(file: string): string | undefined {
	try {
		return readFileSync(file, "utf8");
	} catch (error) {
		if (errorCode(error) === "ENOENT") return undefined;
		throw error;
	}
}

function readText(file: string): string | undefined {
	try {
		return readFileSync(file, "utf8");
	} catch {
		return undefined;
	}
}

/** Hermes' config.yaml text, or undefined when the file is missing. Any other read failure stops planning for Hermes. */
function readHostConfig(file: string): string | undefined {
	try {
		return readFileSync(file, "utf8");
	} catch (error) {
		if (errorCode(error) === "ENOENT") return undefined;
		const detail = error instanceof Error ? error.message : String(error);
		throw new HostConfigError(`could not read ${file}: ${detail}`);
	}
}

/**
 * Writes `value` as JSON through a same-directory temporary file and a rename. `guard.readBefore` is the file's text as
 * the caller read it (undefined when it was absent). The file is re-read just before the rename, and when it changed
 * since, nothing is written and the error says so: a concurrent edit is never overwritten.
 */
export function writeJson(
	file: string,
	value: unknown,
	guard?: { readBefore: string | undefined },
): void {
	const mode = existsSync(file) ? statSync(file).mode & 0o777 : 0o600;
	writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`, {
		mode,
		fs: {
			renameSync: (from, to) => {
				if (guard !== undefined && readRaw(file) !== guard.readBefore)
					throw new Error(`${file} changed since it was read; not overwritten, rerun mcp-register`);
				renameSync(from, to);
			},
		},
	});
}

function report(host: Host, changes: Change[], log: (line: string) => void): void {
	for (const c of changes) log(`  ${host}: ${c.id} ${c.action}${c.reason ? `: ${c.reason}` : ""}`);
}

/** Bounds each host CLI call, so a hung `claude`, `grok` or `hermes` fails its command instead of stalling the run. */
const HOST_COMMAND_TIMEOUT_MS = 60_000;
/** The exit code of a timed-out command (as coreutils `timeout` reports it), so it counts as a failed command. */
const TIMED_OUT_EXIT = 124;

const spawnRun: Run = (cmd, options) => {
	const stdin = options?.stdin === undefined ? "ignore" : Buffer.from(options.stdin);
	const timeoutMs = options?.timeoutMs ?? HOST_COMMAND_TIMEOUT_MS;
	const proc = Bun.spawnSync(cmd, { stdin, stdout: "pipe", stderr: "pipe", timeout: timeoutMs });
	if (proc.exitedDueToTimeout) {
		return {
			code: TIMED_OUT_EXIT,
			stdout: proc.stdout.toString(),
			stderr: `${cmd[0]} timed out after ${timeoutMs / 1000}s`,
		};
	}
	return {
		code: proc.exitCode ?? 1,
		stdout: proc.stdout.toString(),
		stderr: proc.stderr.toString(),
	};
};

const PLANNERS: Record<CliHost, (run: Run, entries: Entry[], options?: PlanOptions) => Plan> = {
	claude: planClaude,
	grok: planGrok,
	hermes: planHermes,
};

export interface ApplyOptions extends PlanOptions {
	log?: (line: string) => void;
}

// Runs the plan's commands, then re-plans to confirm every changed entry is now registered (or gone, for --remove).
// `hermes mcp add|remove` prompt (connection test / confirm); feeding "y\n" saves even when auth is pending.
export function applyCliPlan(
	host: CliHost,
	run: Run,
	entries: Entry[],
	plan: Plan,
	options: ApplyOptions = {},
): Change[] {
	const log = options.log ?? console.log;
	const removing = options.mode === "remove";
	const stdin = host === "hermes" ? "y\n" : undefined;
	const errors = new Map<string, string>();
	for (const cmd of plan.commands) {
		log(`  $ ${cmd.join(" ")}`);
		const result = run(cmd, stdin === undefined ? undefined : { stdin });
		// Outside --remove, `remove` only clears the way for `add` and fails harmlessly when nothing is there.
		if (result.code !== 0 && (removing || cmd[2] !== "remove")) {
			const id = cmd.find((part) => entries.some((e) => e.id === part)) ?? "";
			errors.set(id, `exit ${result.code}: ${result.stderr.trim().split("\n").slice(-1)[0] ?? ""}`);
		}
	}
	const acted = new Set(plan.changes.filter((c) => ACTING[c.action]).map((c) => c.id));
	const changed = entries.filter((e) => acted.has(e.id));
	const after = changed.length ? PLANNERS[host](run, changed, options).changes : [];
	return plan.changes.map((c) => {
		if (!acted.has(c.id)) return c;
		const next = after.find((a) => a.id === c.id)?.action;
		if (next === (removing ? "not registered" : "unchanged")) return c;
		if (!removing && host === "hermes" && next === "re-enabled") {
			return { id: c.id, action: "saved disabled", reason: `${c.id} not authenticated yet` };
		}
		const fallback = removing
			? `still registered after ${host} mcp remove`
			: `not registered after ${host} mcp add`;
		return { id: c.id, action: "FAILED", reason: errors.get(c.id) ?? fallback };
	});
}

function list(value: string | undefined, allowed: readonly string[], name: string): string[] {
	if (!value) return [...allowed];
	const items = value
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	for (const item of items)
		if (!allowed.includes(item)) throw new Error(`unknown ${name}: ${item}`);
	return items;
}

function argValue(argv: string[], name: string): string | undefined {
	const index = argv.indexOf(name);
	return index >= 0 ? argv[index + 1] : undefined;
}

export interface MainDeps {
	run: Run;
	env: Record<string, string | undefined>;
	/** Repository root whose bin/ultrathink-mcp gets registered. */
	root: string;
	log: (line: string) => void;
	now: () => Date;
}

export function main(argv: string[], deps: Partial<MainDeps> = {}): number {
	const run = deps.run ?? spawnRun;
	const env = deps.env ?? process.env;
	const root = deps.root ?? dirname(dirname(fileURLToPath(import.meta.url)));
	const log = deps.log ?? console.log;
	if (argv.includes("--help") || argv.includes("-h")) {
		log(USAGE);
		return 0;
	}
	if (argv.includes("--replace") && argv.includes("--remove"))
		throw new Error("--replace and --remove cannot be combined");
	const mode: Mode = argv.includes("--remove")
		? "remove"
		: argv.includes("--replace")
			? "replace"
			: "add";
	const dryRun = argv.includes("--dry-run");
	const hosts = list(argValue(argv, "--hosts"), HOSTS, "host") as Host[];
	const providers = list(argValue(argv, "--providers"), PROVIDER_IDS, "provider");
	const command = join(root, "bin", "ultrathink-mcp");
	const entries: Entry[] = providers.map((id) => ({ id, command, args: ["serve", id] }));
	const stamp = backupSuffix((deps.now ?? (() => new Date()))());
	const home = env.HOME?.trim() || homedir();
	const config = env.XDG_CONFIG_HOME?.trim() || join(home, ".config");
	const hermesFile = hermesConfigFile(env, home);
	const claudeFile = join(env.CLAUDE_CONFIG_DIR?.trim() || home, ".claude.json");
	const options: ApplyOptions = {
		mode,
		log,
		hermesConfig: () => (hermesFile === undefined ? undefined : readHostConfig(hermesFile)),
		claudeConfig: () => readText(claudeFile),
	};
	let failed = false;
	if (dryRun)
		log(
			"dry run: no file is written and no host is changed; read-only list/get commands still run",
		);
	if (mode !== "remove" && `${root}/`.includes("/plugins/cache/")) {
		log(
			`warning: ${root} is a plugin cache that the next plugin update replaces, which would break the registered commands; clone the repository to a stable directory and rerun mcp-register from there`,
		);
	}

	for (const host of hosts) {
		log(`${host}:`);
		if (host === "omp" || host === "muse") {
			const file =
				host === "omp"
					? join(env.PI_CODING_AGENT_DIR?.trim() || join(home, ".omp", "agent"), "mcp.json")
					: join(config, "muse", "settings.json");
			const before = readRaw(file);
			const current = before === undefined ? undefined : JSON.parse(before);
			const merged =
				host === "omp"
					? mergeOmpMcp(current, entries, mode)
					: mergeMuseSettings(current, entries, mode);
			report(host, merged.changes, log);
			const dirty =
				mode === "remove"
					? merged.changes.some((c) => c.action === "removed")
					: !sameJson(current, merged.next);
			if (!dirty) continue;
			backup(file, stamp, dryRun, log);
			log(`  write ${file}`);
			if (!dryRun) writeJson(file, merged.next, { readBefore: before });
			continue;
		}
		if (!Bun.which(host, { PATH: env.PATH })) {
			log(`  ${host}: not on PATH, skipped`);
			continue;
		}
		let plan: Plan;
		try {
			plan = PLANNERS[host](run, entries, options);
		} catch (error) {
			if (!(error instanceof HostConfigError)) throw error;
			log(`  ${host}: configuration error: ${error.message}; ${host} is not changed`);
			failed = true;
			continue;
		}
		if (!plan.commands.length || dryRun) report(host, plan.changes, log);
		if (!plan.commands.length) continue;
		const configFile =
			host === "claude"
				? claudeFile
				: host === "grok"
					? join(env.GROK_HOME?.trim() || join(home, ".grok"), "config.toml")
					: hermesFile;
		if (configFile === undefined) {
			log(
				"  hermes: the active Hermes profile could not be resolved (check `hermes profile list`); Hermes is not changed",
			);
			continue;
		}
		backup(configFile, stamp, dryRun, log);
		if (dryRun) {
			for (const cmd of plan.commands) log(`  $ ${cmd.join(" ")}`);
			continue;
		}
		const changes = applyCliPlan(host, run, entries, plan, options);
		report(host, changes, log);
		if (changes.some((c) => c.action === "FAILED")) failed = true;
	}
	return failed ? 1 : 0;
}

if (import.meta.main) {
	try {
		process.exit(main(process.argv.slice(2)));
	} catch (error) {
		console.error(`mcp-register: ${error instanceof Error ? error.message : String(error)}`);
		console.error(USAGE);
		process.exit(2);
	}
}
