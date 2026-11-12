// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Golden capture of the Omp host's registered `/ultrathink-*` commands and its `pi.on` hook handlers, taken before any refactor.
 *
 * Creates the extension with `createOmpExtension()` (the default export's factory), records every command it registers
 * through a mocked ExtensionAPI (the surface `src/host/omp-test.helpers.ts` records), invokes each command inside a
 * per-command sandbox, and writes one normalized fixture per command. Rules: see README.md in this directory.
 *
 *   bun test/golden/omp/capture.ts            # writes fixtures/
 *   bun test/golden/omp/capture.ts --out DIR  # writes DIR/ (used for the two-run determinism check)
 */
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, createOmpExtension } from "../../../src/host/omp.ts";
import type { resolveStateDir } from "../../../src/host/paths.ts";
import type { sessionRecordPath } from "../../../src/claude/state.ts";
import type { spawnObserveDetached } from "../../../src/teach/spawn.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(HERE, "fixtures");
const SESSION_ID = "golden-session-1";
const REDACTED = "<REDACTED>";
const SECRET_NAME = /TOKEN|KEY|SECRET|PASSWORD/i;
const TEXT_LIMIT = 64 * 1024;
/** The only inherited variables; everything else is dropped so output cannot depend on the operator's shell. */
const KEPT_ENV = ["PATH", "TMPDIR"];
const PINNED_ENV: Record<string, string> = { TZ: "UTC", LANG: "C.UTF-8", LC_ALL: "C.UTF-8" };

// Normalization patterns, applied in this order (see README.md).
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const HEX_RE = /\b[0-9a-f]{16,}\b/gi;
const ISO_RE =
	/\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?/g;
const CLOCK_RE = /\b\d{2}:\d{2}:\d{2}(?:\.\d+)?\b/g;
const EPOCH_RE = /\b1[67]\d{8}(?:\d{3})?\b/g;
const INBOX_RE = /-[0-9a-f]{8}\.json\b/g;
/** The repo checkout: launch paths into it are recorded as `<REPO>`, not as a machine-specific path. */
const REPO_ROOT = resolve(HERE, "..", "..", "..");

type CommandOptions = {
	description?: string;
	getArgumentCompletions?: (prefix: string) => unknown;
	handler: (args: string | undefined, ctx: unknown) => unknown;
};

interface HostState {
	events: string[];
	commands: Map<string, CommandOptions>;
	renderers: string[];
	sent: { message: unknown; options: unknown }[];
	userMessages: string[];
	handlers: Map<string, Handler[]>;
}

interface CaseSpec {
	name: string;
	args: string;
}

interface Excluded {
	variant: string;
	reason: string;
}

interface CommandSpec {
	entry: string;
	source: string;
	cases: CaseSpec[];
	excluded: Excluded[];
}

interface Sandbox {
	root: string;
	home: string;
	workspace: string;
}

interface Node {
	kind: "file" | "dir" | "other";
	text?: string;
	size: number;
}

interface SideEffect {
	path: string;
	change: "created" | "modified" | "deleted";
	kind: Node["kind"];
	content?: string;
}

const SPECS: CommandSpec[] = [
	{
		entry: "ultrathink-status",
		source: "registerCommand loop, verb=status",
		cases: [{ name: "no prior state", args: "" }],
		excluded: [
			{
				variant: "SuperGrok OAuth logged-in line",
				reason:
					"requires live host: needs a real grok auth.json under the operator's home (sandbox home has none)",
			},
		],
	},
	{
		entry: "ultrathink-on",
		source: "registerCommand loop, verb=on",
		cases: [{ name: "enable planning", args: "" }],
		excluded: [],
	},
	{
		entry: "ultrathink-off",
		source: "registerCommand loop, verb=off",
		cases: [{ name: "disable planning", args: "" }],
		excluded: [],
	},
	{
		entry: "ultrathink-skip",
		source: "registerCommand loop, verb=skip",
		cases: [{ name: "arm skip for the session", args: "" }],
		excluded: [],
	},
	{
		entry: "ultrathink-track",
		source: "registerCommand loop, verb=track (with getArgumentCompletions)",
		cases: [
			{ name: "tracking off", args: "off" },
			{ name: "status after off", args: "status" },
			{ name: "tracking on", args: "on" },
			{ name: "unknown subcommand", args: "bogus" },
		],
		excluded: [],
	},
	{
		entry: "ultrathink-quick",
		source: "registerCommand loop, verb=quick",
		cases: [
			{ name: "message sent as typed", args: "fix the typo in the README" },
			{ name: "no message shows usage", args: "" },
		],
		excluded: [],
	},
	{
		entry: "ultrathink-ui",
		source: "registerCommand('ultrathink-ui') -> openInsightUi (non-TUI host path)",
		cases: [
			{ name: "default overview on a non-TUI host", args: "" },
			{ name: "jev panel", args: "jev" },
			{ name: "card publish", args: "card" },
			{ name: "unknown panel falls back to overview", args: "bogus" },
		],
		excluded: [
			{
				variant: "TUI panel mount (ctx.mode=tui with ui.custom)",
				reason: "requires live host: needs an interactive TUI session",
			},
		],
	},
	{
		entry: "ultrathink-swarm",
		source: "registerCommand('ultrathink-swarm') -> parseLaneArgs / resolveSwarmRoot refusal paths",
		cases: [
			{ name: "no briefs: usage", args: "" },
			{ name: "status without a swarm root", args: "status" },
			{ name: "stop with no lanes", args: "stop" },
			{ name: "spawn refused without a swarm root", args: "Brief one | Brief two" },
		],
		excluded: [
			{
				variant: "spawn lanes with ULTRATHINK_SWARM_ROOT set",
				reason:
					"requires live host: spawns detached AgentSwarm lane processes from a real checkout",
			},
			{
				variant: "stop a running lane",
				reason: "requires live host: needs a running lane process to signal",
			},
		],
	},
];

/** Secret-named variables keep their names but lose their values before any module reads the environment. */
function redactSecretEnv(): number {
	let count = 0;
	for (const name of Object.keys(process.env)) {
		if (!SECRET_NAME.test(name)) continue;
		process.env[name] = REDACTED;
		count++;
	}
	return count;
}

function makeSandbox(runRoot: string, name: string): Sandbox {
	const root = join(runRoot, name);
	const home = join(root, "home");
	const workspace = join(root, "workspace");
	mkdirSync(home, { recursive: true });
	mkdirSync(workspace, { recursive: true });
	return { root, home, workspace };
}

/** Replaces the process environment with the pinned allowlist, every host-state dir pointing into the sandbox. */
function pinEnv(sb: Sandbox): void {
	for (const name of Object.keys(process.env)) {
		if (SECRET_NAME.test(name) || KEPT_ENV.includes(name)) continue;
		delete process.env[name];
	}
	const pinned: Record<string, string> = {
		...PINNED_ENV,
		HOME: sb.home,
		PI_CODING_AGENT_DIR: join(sb.root, "omp-agent"),
		XDG_CONFIG_HOME: join(sb.root, "xdg"),
		CLAUDE_CONFIG_DIR: join(sb.root, "claude"),
		GROK_HOME: join(sb.root, "grok"),
		HERMES_HOME: join(sb.root, "hermes"),
		PRIME_AGENT_CODING_AGENT_DIR: join(sb.root, "prime"),
	};
	for (const [name, value] of Object.entries(pinned)) process.env[name] = value;
}

function readNode(abs: string): Node {
	const bytes = readFileSync(abs);
	if (bytes.length <= TEXT_LIMIT) {
		try {
			return {
				kind: "file",
				text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
				size: bytes.length,
			};
		} catch {
			// reason: not valid UTF-8, so it is recorded as binary below
		}
	}
	return { kind: "file", size: bytes.length };
}

function snapshotTree(root: string): Map<string, Node> {
	const nodes = new Map<string, Node>();
	const walk = (dir: string): void => {
		for (const name of readdirSync(dir).sort()) {
			const abs = join(dir, name);
			const rel = relative(root, abs).split(sep).join("/");
			const st = lstatSync(abs);
			if (st.isDirectory()) {
				nodes.set(rel, { kind: "dir", size: 0 });
				walk(abs);
			} else if (st.isFile()) {
				nodes.set(rel, readNode(abs));
			} else {
				nodes.set(rel, { kind: "other", size: st.size });
			}
		}
	};
	walk(root);
	return nodes;
}

function effect(path: string, change: "created" | "modified", node: Node): SideEffect {
	const out: SideEffect = { path, change, kind: node.kind };
	if (node.kind === "file") out.content = node.text ?? `<binary, ${node.size} bytes>`;
	return out;
}

/** Path-sorted diff: the manifest is an unordered collection, so its order is fixed by path. */
function diffTrees(before: Map<string, Node>, after: Map<string, Node>): SideEffect[] {
	const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
	const out: SideEffect[] = [];
	for (const path of paths) {
		const a = before.get(path);
		const b = after.get(path);
		if (!a && b) out.push(effect(path, "created", b));
		else if (a && !b) out.push({ path, change: "deleted", kind: a.kind });
		else if (a && b && (a.kind !== b.kind || a.text !== b.text || a.size !== b.size))
			out.push(effect(path, "modified", b));
	}
	return out;
}

/** Ordinal placeholders <ID-n> are numbered per case, in order of first appearance. */
class Normalizer {
	readonly #ids = new Map<string, string>();

	constructor(private readonly roots: readonly string[]) {}

	#id(raw: string): string {
		let placeholder = this.#ids.get(raw);
		if (placeholder === undefined) {
			placeholder = `<ID-${this.#ids.size + 1}>`;
			this.#ids.set(raw, placeholder);
		}
		return placeholder;
	}

	text(input: string): string {
		let out = input.split(REPO_ROOT).join("<REPO>");
		for (const root of this.roots) out = out.split(root).join("<ROOT>");
		out = out.replace(UUID_RE, (m) => this.#id(m)).replace(HEX_RE, (m) => this.#id(m));
		// The teach inbox file name is `<epoch ms>-<8 random hex>.json`; the random part is recorded as `<RAND>`.
		out = out.replace(INBOX_RE, "-<RAND>.json");
		return out.replace(ISO_RE, "<TS>").replace(CLOCK_RE, "<TS>").replace(EPOCH_RE, "<TS>");
	}

	value(v: unknown): unknown {
		if (typeof v === "string") return this.text(v);
		if (Array.isArray(v)) return v.map((item) => this.value(item));
		if (v !== null && typeof v === "object") {
			const record = v as Record<string, unknown>;
			const out: Record<string, unknown> = {};
			for (const key of Object.keys(record).sort()) out[this.text(key)] = this.value(record[key]);
			return out;
		}
		// Numeric epoch stamps (seconds or milliseconds in the 2020–2030 range) are timestamps, not data.
		if (
			typeof v === "number" &&
			Number.isInteger(v) &&
			((v >= 1.6e9 && v < 1.9e9) || (v >= 1.6e12 && v < 1.9e12))
		)
			return "<TS>";
		return v;
	}
}

/** JSON round trip so recorded values are plain data: functions become a marker, undefined is dropped. */
function toPlain(v: unknown): unknown {
	const json = JSON.stringify(v, (_key, x: unknown) =>
		typeof x === "function" ? "<function>" : x,
	);
	return json === undefined ? null : JSON.parse(json);
}

function normalizeCase(raw: unknown, roots: readonly string[]): unknown {
	return new Normalizer(roots).value(toPlain(raw));
}

function createHost(): { pi: ExtensionAPI; state: HostState } {
	const state: HostState = {
		events: [],
		commands: new Map(),
		renderers: [],
		sent: [],
		userMessages: [],
		handlers: new Map(),
	};
	const pi = {
		on: (event: string, handler: Handler) => {
			state.events.push(event);
			state.handlers.set(event, [...(state.handlers.get(event) ?? []), handler]);
		},
		sendMessage: (message: unknown, options: unknown) => {
			state.sent.push({ message, options });
		},
		sendUserMessage: (content: string) => {
			state.userMessages.push(content);
		},
		registerCommand: (name: string, options: CommandOptions) => {
			state.commands.set(name, options);
		},
		registerMessageRenderer: (type: string) => {
			state.renderers.push(type);
		},
	} as unknown as ExtensionAPI;
	return { pi, state };
}

async function runCase(
	state: HostState,
	sb: Sandbox,
	entry: string,
	c: CaseSpec,
	roots: readonly string[],
): Promise<unknown> {
	const command = state.commands.get(entry);
	if (!command) throw new Error(`${entry} is not registered`);
	const before = snapshotTree(sb.root);
	state.sent.length = 0;
	state.userMessages.length = 0;
	const notices: { text: string; level?: string }[] = [];
	const ctx = {
		cwd: sb.workspace,
		sessionManager: { getSessionId: () => SESSION_ID },
		ui: {
			notify: (text: string, level?: string) => {
				notices.push({ text, level });
			},
		},
	};
	let threw: string | undefined;
	try {
		await command.handler(c.args, ctx);
	} catch (error) {
		threw = error instanceof Error ? error.message : String(error);
	}
	const after = snapshotTree(sb.root);
	return normalizeCase(
		{
			name: c.name,
			input: {
				command: `/${entry} ${c.args}`.trimEnd(),
				args: c.args,
				sessionId: SESSION_ID,
				cwd: sb.workspace,
			},
			output: {
				notices,
				sentMessages: state.sent.map((s) => ({ message: s.message, options: s.options })),
				userMessages: [...state.userMessages],
				threw,
			},
			sideEffects: diffTrees(before, after),
		},
		roots,
	);
}

function registrationFixture(state: HostState, roots: readonly string[]): unknown {
	const commands = [...state.commands.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([name, options]) => ({
			name,
			description: options.description ?? null,
			argumentCompletions: options.getArgumentCompletions
				? { "": options.getArgumentCompletions(""), o: options.getArgumentCompletions("o") }
				: null,
		}));
	return normalizeCase(
		{
			schema: 1,
			entry: "registration",
			source: "src/host/omp.ts createOmpExtension(): registerCommand, registerMessageRenderer, on",
			capture: "test/golden/omp/capture.ts",
			commands,
			eventHandlers: [...new Set(state.events)].sort(),
			messageRenderers: [...new Set(state.renderers)].sort(),
		},
		roots,
	);
}

// ---------------------------------------------------------------------------
// Hook handlers (`pi.on`). A case drives every handler registered for its event, in registration order, through the same
// mocked ExtensionAPI. Each case gets its own sandbox and a fresh extension, so no case sees another's state.
// ---------------------------------------------------------------------------

type Handler = (event: unknown, ctx: unknown) => unknown;
type Notice = { text: string; level?: string };

/** One detached `teach observe` launch. The launcher is recorded, never started. */
interface Launch {
	cmd: string;
	args: string[];
	cwd: string;
	env: Record<string, string | undefined>;
}

/** Modules imported after the pinned environment exists (see `main`). */
interface CaptureDeps {
	createOmpExtension: typeof createOmpExtension;
	spawnObserveDetached: typeof spawnObserveDetached;
	resolveStateDir: typeof resolveStateDir;
	sessionRecordPath: typeof sessionRecordPath;
}

interface HookStep {
	/** A registered hook event, or `command:<name>` to run a registered command as a probe on the same host. */
	on: string;
	event?: unknown;
	args?: string;
	sessionId?: string;
	/** Context cwd, relative to the sandbox workspace. Defaults to the workspace. */
	cwd?: string;
}

interface HookCase {
	name: string;
	/** Seeds the sandbox before the baseline snapshot; the returned plain data is recorded as `input.setup`. */
	setup?: (sb: Sandbox, deps: CaptureDeps) => unknown;
	steps: HookStep[];
}

interface HookSpec {
	file: string;
	entry: string;
	source: string;
	cases: HookCase[];
	excluded: Excluded[];
}

/** Pins git identity and dates so setup repositories are identical on every run; setup is never recorded. */
const GIT_ENV: Record<string, string> = {
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_AUTHOR_NAME: "golden",
	GIT_AUTHOR_EMAIL: "golden@example.invalid",
	GIT_COMMITTER_NAME: "golden",
	GIT_COMMITTER_EMAIL: "golden@example.invalid",
	GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
	GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
};

function gitRun(cwd: string, args: string[]): void {
	execFileSync("git", args, { cwd, env: { ...process.env, ...GIT_ENV }, stdio: "ignore" });
}

function writeFiles(dir: string, files: Record<string, string>): void {
	for (const [rel, text] of Object.entries(files)) {
		mkdirSync(dirname(join(dir, rel)), { recursive: true });
		writeFileSync(join(dir, rel), text);
	}
}

/** A local repository on `main`. `refs/remotes/origin/main` is set locally; the remote is never contacted. */
function makeRepo(dir: string, origin: string): void {
	mkdirSync(dir, { recursive: true });
	gitRun(dir, ["init", "--quiet", "--initial-branch=main"]);
	gitRun(dir, ["remote", "add", "origin", origin]);
	writeFiles(dir, { "README.md": "repo\n" });
	gitRun(dir, ["add", "-A"]);
	gitRun(dir, ["commit", "--quiet", "-m", "base"]);
	gitRun(dir, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
}

/** `makeRepo`, then one commit on `feature/golden`: one commit ahead of origin/main. */
function makeFeatureRepo(dir: string, origin: string): void {
	makeRepo(dir, origin);
	gitRun(dir, ["checkout", "--quiet", "-b", "feature/golden"]);
	writeFiles(dir, { "src/app.ts": "export const app = 1;\n" });
	gitRun(dir, ["add", "-A"]);
	gitRun(dir, ["commit", "--quiet", "-m", "feature"]);
}

/** Writes the user's `ultrathink.json` where `claudeConfigPaths` reads it (CLAUDE_CONFIG_DIR is pinned to `claude/`). */
function writeConfig(sb: Sandbox, config: Record<string, unknown>): unknown {
	const dir = join(sb.root, "claude");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "ultrathink.json"), `${JSON.stringify(config, null, 2)}\n`);
	return { file: "claude/ultrathink.json", config };
}

/** The fields of a planned prompt's session record that the hooks read. The planner itself is not run. */
function planned(repo: string, skill?: string): Record<string, unknown> {
	return {
		plan: { graphId: "graph-golden-1", task: { title: "golden task", repo } },
		...(skill === undefined ? {} : { skill: { name: skill, source: "user" } }),
	};
}

/** Writes the session record a planned prompt leaves in the state dir that `stateDir(cwd)` resolves to. */
function seedRecord(cwd: string, deps: CaptureDeps, record: Record<string, unknown>): unknown {
	const dir = resolve(cwd, deps.resolveStateDir({ ...process.env, ULTRATHINK_HOST: "omp" }));
	const path = deps.sessionRecordPath(dir, SESSION_ID);
	const body = { sessionId: SESSION_ID, at: 0, result: {}, ...record };
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`);
	return { path, record: body };
}

/** Two repos under the workspace: `repo` (origin acme/app, the plan's repo) and `other` (origin acme/other). */
function editSetup(seeded: boolean): NonNullable<HookCase["setup"]> {
	return (sb, deps) => {
		const app = join(sb.workspace, "repo");
		makeRepo(app, "git@github.com:acme/app.git");
		makeRepo(join(sb.workspace, "other"), "git@github.com:acme/other.git");
		return {
			repos: [
				{ path: "repo", origin: "git@github.com:acme/app.git" },
				{ path: "other", origin: "git@github.com:acme/other.git" },
			],
			seeded: seeded ? seedRecord(app, deps, planned("acme/app")) : null,
		};
	};
}

/** A feature branch one commit ahead of origin/main, with the ship switch on in the user's config. */
function shipSetup(seeded: { skill: string } | "no-plan"): NonNullable<HookCase["setup"]> {
	return (sb, deps) => {
		const config = writeConfig(sb, { ship: { enabled: true } });
		const app = join(sb.workspace, "app");
		makeFeatureRepo(app, "git@github.com:acme/app.git");
		return {
			config,
			repo: { path: "app", branch: "feature/golden", origin: "git@github.com:acme/app.git" },
			seeded:
				seeded === "no-plan" ? null : seedRecord(app, deps, planned("acme/app", seeded.skill)),
		};
	};
}

/** An `agent_end` payload: a user prompt, four tool calls, and a final assistant message that ended with `stopReason`. */
function agentRun(stopReason: string): Record<string, unknown> {
	return {
		messages: [
			{ role: "user", content: [{ type: "text", text: "Capture the Omp hook handlers" }] },
			{
				role: "assistant",
				stopReason: "toolUse",
				content: ["read", "grep", "edit", "bash"].map((name) => ({
					type: "toolCall",
					name,
					arguments: { path: "src/host/omp.ts" },
				})),
			},
			{ role: "assistant", stopReason, content: [{ type: "text", text: "Captured." }] },
		],
	};
}

/** A `tool_result` payload: tool name, input, text output, and whether the tool failed. */
function toolResult(
	toolName: string,
	input: Record<string, unknown>,
	text: string,
	isError = false,
): Record<string, unknown> {
	return { toolName, input, isError, content: [{ type: "text", text }] };
}

/** The real `spawnObserveDetached` with only the process launch replaced by a recorder: the inbox write and argv run as in production. */
function recordingObserve(
	launches: Launch[],
	real: CaptureDeps["spawnObserveDetached"],
): CaptureDeps["spawnObserveDetached"] {
	return (digest, options) =>
		real(digest, {
			...options,
			spawn: (cmd, args, opts) => {
				launches.push({
					cmd,
					args,
					cwd: opts.cwd,
					env: Object.fromEntries(
						Object.entries(opts.env).filter(([name]) => name.startsWith("ULTRATHINK_")),
					),
				});
				// The launch is recorded, not started: `pid: 0` only satisfies the launcher's "did it start" check.
				return { pid: 0 };
			},
		});
}

/** Runs one step: a hook (every handler registered for it, each with its own output) or a `command:` probe. */
async function runHookStep(
	state: HostState,
	launches: Launch[],
	sb: Sandbox,
	step: HookStep,
): Promise<{ input: unknown; output: unknown }> {
	const sessionId = step.sessionId ?? SESSION_ID;
	const notices: Notice[] = [];
	const ctx = {
		cwd: join(sb.workspace, step.cwd ?? "."),
		sessionManager: { getSessionId: () => sessionId },
		ui: {
			notify: (text: string, level?: string) => {
				notices.push({ text, level });
			},
		},
	};
	const targets: { handler: number | "command"; run: () => unknown }[] = [];
	if (step.on.startsWith("command:")) {
		const name = step.on.slice("command:".length);
		const command = state.commands.get(name);
		if (!command) throw new Error(`${name} is not registered`);
		targets.push({ handler: "command", run: () => command.handler(step.args ?? "", ctx) });
	} else {
		for (const [handler, fn] of (state.handlers.get(step.on) ?? []).entries())
			targets.push({ handler, run: () => fn(step.event ?? {}, ctx) });
	}
	const handlers: unknown[] = [];
	for (const target of targets) {
		state.sent.length = 0;
		state.userMessages.length = 0;
		launches.length = 0;
		let threw: string | undefined;
		try {
			await target.run();
		} catch (error) {
			threw = error instanceof Error ? error.message : String(error);
		}
		handlers.push({
			handler: target.handler,
			notices: notices.splice(0),
			sentMessages: state.sent.map((s) => ({ message: s.message, options: s.options })),
			userMessages: [...state.userMessages],
			launches: launches.splice(0),
			threw,
		});
	}
	return {
		input: {
			on: step.on,
			event: step.event ?? null,
			args: step.args ?? null,
			sessionId,
			cwd: step.cwd ?? ".",
		},
		output: { handlers },
	};
}

async function runHookCase(
	spec: HookSpec,
	c: HookCase,
	index: number,
	runRoot: string,
	roots: readonly string[],
	deps: CaptureDeps,
): Promise<unknown> {
	const sb = makeSandbox(runRoot, `${spec.file}-${index}`);
	pinEnv(sb);
	const launches: Launch[] = [];
	const host = createHost();
	deps.createOmpExtension({
		spawnObserve: recordingObserve(launches, deps.spawnObserveDetached),
	})(host.pi);
	const setup = c.setup ? c.setup(sb, deps) : null;
	const before = snapshotTree(sb.root);
	const steps: { input: unknown; output: unknown }[] = [];
	for (const step of c.steps) steps.push(await runHookStep(host.state, launches, sb, step));
	const after = snapshotTree(sb.root);
	const normalized = normalizeCase(
		{
			name: c.name,
			input: { setup, steps: steps.map((s) => s.input) },
			output: { steps: steps.map((s) => s.output) },
			sideEffects: diffTrees(before, after),
		},
		roots,
	) as { sideEffects: SideEffect[] };
	// Two files can share a normalized name (teach inbox files are `<TS>-<RAND>.json`): order by normalized path, then by
	// content, so the order cannot depend on the random names.
	normalized.sideEffects.sort((a, b) => {
		if (a.path !== b.path) return a.path < b.path ? -1 : 1;
		const x = JSON.stringify(a);
		const y = JSON.stringify(b);
		return x < y ? -1 : x > y ? 1 : 0;
	});
	return normalized;
}

const HOOK_SPECS: HookSpec[] = [
	{
		file: "hook-session-start",
		entry: "session_start",
		source: "src/host/omp.ts pi.on('session_start')",
		cases: [{ name: "non-TUI start: no output", steps: [{ on: "session_start" }] }],
		excluded: [
			{
				variant: "TUI start: activity-receipt poll and status-bar mount",
				reason:
					"requires live host: both run only when ctx.mode is 'tui' with ui.setWidget (an interactive Omp TUI)",
			},
			{
				variant: "live session id held in the bar store",
				reason:
					"requires live host: liveSessionId is read only by the TUI bar renderer; no non-TUI output includes it",
			},
		],
	},
	{
		file: "hook-session-switch",
		entry: "session_switch",
		source: "src/host/omp.ts pi.on('session_switch')",
		cases: [
			{ name: "switch with no open dashboard: no output", steps: [{ on: "session_switch" }] },
			{
				name: "switch after /ultrathink-ui: the non-TUI snapshot already closed the dashboard, so no notice",
				steps: [{ on: "command:ultrathink-ui" }, { on: "session_switch" }],
			},
			{
				name: "repeated switch: no output",
				steps: [
					{ on: "command:ultrathink-ui" },
					{ on: "session_switch" },
					{ on: "session_switch" },
				],
			},
		],
		excluded: [
			{
				variant: "switch while a planner flight runs (cancelled, delivery suppressed)",
				reason:
					"requires live host: a planner flight starts in before_agent_start and calls a model provider over the network",
			},
			{
				variant: "switch with a dashboard mounted in the TUI (component disposal)",
				reason: "requires live host: the dashboard mounts only with ctx.mode 'tui' and ui.custom",
			},
		],
	},
	{
		file: "hook-session-shutdown",
		entry: "session_shutdown",
		source: "src/host/omp.ts pi.on('session_shutdown')",
		cases: [
			{ name: "shutdown with nothing running: no output", steps: [{ on: "session_shutdown" }] },
			{
				name: "shutdown after /ultrathink-ui: nothing left to close; the later switch probe has no notice",
				steps: [
					{ on: "command:ultrathink-ui" },
					{ on: "session_shutdown" },
					{ on: "session_switch" },
				],
			},
		],
		excluded: [
			{
				variant: "shutdown stops the TUI activity-receipt poll",
				reason: "requires live host: the poll starts only in the TUI (ctx.mode 'tui')",
			},
			{
				variant: "shutdown cancels a running planner flight",
				reason: "requires live host: a planner flight calls a model provider over the network",
			},
			{
				variant: "shutdown while a TUI dashboard is open (teardown of a mounted component)",
				reason:
					"requires live host: a dashboard stays open past its command only in the TUI (ctx.mode 'tui' with ui.custom)",
			},
		],
	},
	{
		file: "hook-observe",
		entry: "agent_start | turn_end | tool_execution_start | tool_execution_end",
		source: "src/host/omp.ts pi.on(event) loop: observeFlights, then scheduleMount",
		cases: [
			{
				name: "observer events with no flight: no output",
				steps: [
					{ on: "agent_start" },
					{ on: "tool_execution_start" },
					{ on: "tool_execution_end" },
					{ on: "turn_end" },
				],
			},
			{
				name: "observer in another session after /ultrathink-ui: nothing left to drop; no output",
				steps: [
					{ on: "command:ultrathink-ui" },
					{ on: "turn_end", sessionId: "golden-session-2" },
					{ on: "session_switch" },
				],
			},
		],
		excluded: [
			{
				variant: "observer cancels a planner flight whose session or cwd changed",
				reason:
					"requires live host: a planner flight starts in before_agent_start and calls a model provider over the network",
			},
			{
				variant: "observer while a TUI dashboard is open (silent teardown of a mounted component)",
				reason:
					"requires live host: a dashboard stays open past its command only in the TUI (ctx.mode 'tui' with ui.custom)",
			},
		],
	},
	{
		file: "hook-turn-start",
		entry: "turn_start",
		source: "src/host/omp.ts pi.on('turn_start')",
		cases: [
			{ name: "one turn start with no flight: no output", steps: [{ on: "turn_start" }] },
			{
				name: "two turn starts: no output",
				steps: [{ on: "turn_start" }, { on: "turn_start" }],
			},
		],
		excluded: [
			{
				variant: "turn counter gating the before_agent_start re-run check",
				reason:
					"requires live host: the counter is read only by before_agent_start, which calls a model provider over the network",
			},
		],
	},
	{
		file: "hook-tool-result",
		entry: "tool_result",
		source:
			"src/host/omp.ts pi.on('tool_result') x2: handler 0 = edit attribution, handler 1 = PR-sync nudge",
		cases: [
			{
				name: "write into the plan's repo: attribution recorded, no warning",
				setup: editSetup(true),
				steps: [
					{
						on: "tool_result",
						cwd: "repo",
						event: toolResult("write", { path: "src/app.ts" }, "ok"),
					},
				],
			},
			{
				name: "write into another repo: one warning; the same edit again is silent",
				setup: editSetup(true),
				steps: [
					{
						on: "tool_result",
						cwd: "repo",
						event: toolResult("write", { path: "../other/lib.ts" }, "ok"),
					},
					{
						on: "tool_result",
						cwd: "repo",
						event: toolResult("write", { path: "../other/lib.ts" }, "ok"),
					},
				],
			},
			{
				name: "failed write: nothing recorded",
				setup: editSetup(true),
				steps: [
					{
						on: "tool_result",
						cwd: "repo",
						event: toolResult("write", { path: "src/app.ts" }, "denied", true),
					},
				],
			},
			{
				name: "write outside any git repo: nothing recorded",
				setup: (sb, deps) => ({
					repos: [],
					seeded: seedRecord(sb.workspace, deps, planned("acme/app")),
				}),
				steps: [{ on: "tool_result", event: toolResult("write", { path: "notes/todo.md" }, "ok") }],
			},
			{
				name: "gh pr create in a tracked session: one sync nudge per PR URL",
				setup: editSetup(true),
				steps: [
					{
						on: "tool_result",
						cwd: "repo",
						event: toolResult(
							"bash",
							{ command: "gh pr create --title golden --body capture" },
							"https://github.com/acme/app/pull/42\n",
						),
					},
					{
						on: "tool_result",
						cwd: "repo",
						event: toolResult(
							"bash",
							{ command: "gh pr create --title golden --body capture" },
							"https://github.com/acme/app/pull/42\n",
						),
					},
					{
						on: "tool_result",
						cwd: "repo",
						event: toolResult("github", { op: "pr_create" }, "https://github.com/acme/app/pull/43"),
					},
				],
			},
			{
				name: "PR opened with no tracked plan: no nudge",
				setup: editSetup(false),
				steps: [
					{
						on: "tool_result",
						cwd: "repo",
						event: toolResult(
							"bash",
							{ command: "gh pr create --title golden --body capture" },
							"https://github.com/acme/app/pull/42\n",
						),
					},
				],
			},
		],
		excluded: [
			{
				variant: "PR opened by a subagent session",
				reason:
					"requires live host: subagent detection reads the session-file layout of a live Omp subagent",
			},
		],
	},
	{
		file: "hook-agent-end",
		entry: "agent_end",
		source:
			"src/host/omp.ts pi.on('agent_end') x2: handler 0 = observeFlights, handler 1 = teach observe handoff then ship nudge",
		cases: [
			{
				name: "finished run, default config: teach observe handed off; ship off by default",
				steps: [{ on: "agent_end", event: agentRun("stop") }],
			},
			{
				name: "aborted run: not observed",
				steps: [{ on: "agent_end", event: agentRun("aborted") }],
			},
			{
				name: "teach capture explicit: not observed",
				setup: (sb) => writeConfig(sb, { teach: { capture: "explicit" } }),
				steps: [{ on: "agent_end", event: agentRun("stop") }],
			},
			{
				name: "GSD run committed on a feature branch: ship nudge once",
				setup: shipSetup({ skill: "gsd-execute-phase" }),
				steps: [
					{ on: "agent_end", cwd: "app", event: agentRun("stop") },
					{ on: "agent_end", cwd: "app", event: agentRun("stop") },
				],
			},
			{
				name: "non-GSD skill on a feature branch: no ship nudge",
				setup: shipSetup({ skill: "custom-skill" }),
				steps: [{ on: "agent_end", cwd: "app", event: agentRun("stop") }],
			},
			{
				name: "ship enabled, no tracked plan: no ship nudge",
				setup: shipSetup("no-plan"),
				steps: [{ on: "agent_end", cwd: "app", event: agentRun("stop") }],
			},
		],
		excluded: [
			{
				variant: "ultrathink-ship run after the nudge (PR, Greptile review, merge)",
				reason:
					"requires live host: the agent runs the ship skill, which opens a PR and calls Greptile and GitHub over the network",
			},
			{
				variant: "teach observe supervisor actually started",
				reason:
					"requires live host: the detached supervisor runs `teach observe` against the Teachable Moments store; the launch is recorded, never started",
			},
		],
	},
];

function clearFixtures(outDir: string): void {
	if (!existsSync(outDir)) return;
	for (const name of readdirSync(outDir)) if (name.endsWith(".json")) rmSync(join(outDir, name));
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const at = argv.indexOf("--out");
	const outDir = at >= 0 && argv[at + 1] ? resolve(argv[at + 1] ?? "") : FIXTURE_DIR;
	const redacted = redactSecretEnv();

	const rawRoot = mkdtempSync(join(tmpdir(), "omp-golden-"));
	const runRoot = realpathSync(rawRoot);
	const roots = [...new Set([rawRoot, runRoot])];
	try {
		pinEnv(makeSandbox(runRoot, "_bootstrap"));
		// Dynamic on purpose: a static import evaluates omp.ts's whole import graph before the pinned environment above
		// exists, so any module-level read of process.env in that graph would see the host environment instead.
		const { createOmpExtension } = await import("../../../src/host/omp.ts");
		// Dynamic like omp.ts above: each loads after the pinned environment exists, so a module-level env read sees the sandbox.
		const { spawnObserveDetached } = await import("../../../src/teach/spawn.ts");
		const { resolveStateDir } = await import("../../../src/host/paths.ts");
		const { sessionRecordPath } = await import("../../../src/claude/state.ts");
		const deps: CaptureDeps = {
			createOmpExtension,
			spawnObserveDetached,
			resolveStateDir,
			sessionRecordPath,
		};

		clearFixtures(outDir);
		mkdirSync(outDir, { recursive: true });

		const registration = createHost();
		createOmpExtension()(registration.pi);
		writeFileSync(
			join(outDir, "registration.json"),
			`${JSON.stringify(registrationFixture(registration.state, roots), null, 2)}\n`,
		);
		console.log(`captured registration (${registration.state.commands.size} commands)`);

		for (const spec of SPECS) {
			const sb = makeSandbox(runRoot, spec.entry);
			pinEnv(sb);
			const host = createHost();
			createOmpExtension()(host.pi);
			const cases: unknown[] = [];
			for (const c of spec.cases) cases.push(await runCase(host.state, sb, spec.entry, c, roots));
			const fixture = {
				schema: 1,
				entry: spec.entry,
				source: spec.source,
				capture: "test/golden/omp/capture.ts",
				cases,
				excluded: spec.excluded,
			};
			writeFileSync(
				join(outDir, `${spec.entry}.json`),
				`${JSON.stringify(normalizeCase(fixture, roots), null, 2)}\n`,
			);
			console.log(
				`captured ${spec.entry} (${spec.cases.length} cases, ${spec.excluded.length} excluded)`,
			);
		}

		for (const spec of HOOK_SPECS) {
			const cases: unknown[] = [];
			for (const [index, c] of spec.cases.entries())
				cases.push(await runHookCase(spec, c, index, runRoot, roots, deps));
			const fixture = {
				schema: 1,
				kind: "hook",
				entry: spec.entry,
				source: spec.source,
				capture: "test/golden/omp/capture.ts",
				cases,
				excluded: spec.excluded,
			};
			writeFileSync(
				join(outDir, `${spec.file}.json`),
				`${JSON.stringify(normalizeCase(fixture, roots), null, 2)}\n`,
			);
			console.log(
				`captured ${spec.file} (${spec.cases.length} cases, ${spec.excluded.length} excluded)`,
			);
		}
		console.log(`secret-named env vars redacted: ${redacted}`);
		console.log(`fixtures written to ${outDir}`);
	} finally {
		rmSync(runRoot, { recursive: true, force: true });
	}
}

await main();
process.exit(0);
