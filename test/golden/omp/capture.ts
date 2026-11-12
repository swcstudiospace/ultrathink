// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Golden capture of the Omp host's registered `/ultrathink-*` commands, taken before any refactor.
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
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "../../../src/host/omp.ts";

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
		let out = input;
		for (const root of this.roots) out = out.split(root).join("<ROOT>");
		out = out.replace(UUID_RE, (m) => this.#id(m)).replace(HEX_RE, (m) => this.#id(m));
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
	};
	const pi = {
		on: (event: string) => {
			state.events.push(event);
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
		console.log(`secret-named env vars redacted: ${redacted}`);
		console.log(`fixtures written to ${outDir}`);
	} finally {
		rmSync(runRoot, { recursive: true, force: true });
	}
}

await main();
process.exit(0);
