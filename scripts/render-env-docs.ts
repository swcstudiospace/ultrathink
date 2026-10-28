#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * scripts/render-env-docs.ts — renders docs/environment.md from the environment registry (src/env-registry.ts).
 *
 * The committed file is the output of {@link renderEnvDocs}: a frozen head that states the precedence of each setting
 * family, then one table per scope. Nothing in the tables is typed by hand, so a variable added to the registry shows
 * up here by regenerating, and `scripts/render-env-docs.test.ts` fails until the file is regenerated. That test is the
 * only doc-versus-code check; no test reads source text.
 *
 * The output never contains a value from the environment: it reads only the registry, never `process.env`.
 *
 * CLI: `bun scripts/render-env-docs.ts` writes docs/environment.md; `--check` writes nothing and exits 1 when the file
 * is stale.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ENV_REGISTRY, type EnvScope, type EnvVarDef } from "../src/env-registry.ts";
import { STACK_LIVE_COST_LINE } from "../src/stack/cli.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Where the generated reference lives, relative to the repository root. */
const ENV_DOCS_FILE = "docs/environment.md";

const HEAD = `# Environment variables

This file is generated from the environment registry (\`src/env-registry.ts\`) by \`bun scripts/render-env-docs.ts\`. Do not edit it by hand: a test fails when it differs from what the registry renders. Every variable below is optional unless its description says it is required. \`.env.example\` has one placeholder line per variable. [Configuration](configuration.md) explains the config files these variables sit next to.

A variable that is empty or only whitespace counts as unset. A bad value is never fatal for the plugin: the reader falls back to its default, and \`ultrathink doctor\` names the variable (never its value). The hosted service is stricter: it refuses to start on a bad value.

## Which source wins

The order differs by setting family. Each line below is how the code resolves it today.

- **Substrate URL.** \`SUBSTRATE_URL\` wins over \`substrate.url\` in the config file. \`SUBSTRATE_DISABLED=1\` beats both and no request is made.
- **Substrate bearer.** \`SUBSTRATE_TOKEN\`, then the first line of the file named by \`SUBSTRATE_TOKEN_FILE\`, then the first line of \`SUBSTRATE_TOKENS_DIR/<surface>\`. There is no stored copy.
- **Hindsight URL.** \`hindsight.url\` in the config file, then \`HINDSIGHT_API_URL\`, then \`HINDSIGHT_URL\`. This is the reverse of the Substrate URL: the config file wins here.
- **Swarm root.** A non-empty \`ULTRATHINK_SWARM_ROOT\` wins; \`SWARM_ROOT\` is read only when it is empty.
- **Secrets.** A key stored in the credential store (\`bin/ultrathink-mcp auth set-key <provider> --stdin\`) wins over its environment variable, for Hindsight (then \`HINDSIGHT_API_KEY\`, then \`HINDSIGHT_API_TOKEN\`), RAGFlow, the desk gateway, OpenRouter (\`ULTRATHINK_OPENROUTER_KEY\`) and Vercel (\`AI_GATEWAY_API_KEY\`).
- **Backend selectors.** \`ULTRATHINK_HINDSIGHT_BACKEND\`, \`ULTRATHINK_RAGFLOW_BACKEND\` and \`ULTRATHINK_SUBSTRATE_BACKEND\` (\`direct\` or \`gateway\`) win over the \`backend\` key of their config section. Any other value is ignored. \`ULTRATHINK_GATEWAY=0\` forces every one of them to \`direct\`.
- **Kill switches.** An environment kill switch wins over the config file, and no config key turns the feature back on. Only the one value shown in the table switches it off: \`0\` for the \`ULTRATHINK_*\` switches, \`off\` for \`ULTRATHINK_REALM\`, and \`1\` for \`SUBSTRATE_DISABLED\`. Any other value leaves the feature on and \`ultrathink doctor\` reports it. \`ULTRATHINK_RAGFLOW\` ignores whitespace around the \`0\`, and \`ULTRATHINK_REALM\` ignores case and whitespace.
- **Project config.** The project file \`<cwd>/.claude/ultrathink.json\` is read last but is limited. It cannot choose executables, the desk gateway, the state settings, the Cursor pstack bridge or swarm auto-run, and for Hindsight, RAGFlow and Teachable Moments it can only turn a feature off or lower it. The user files are not limited.

## Checking your settings

- \`ultrathink doctor\` runs nine sections. The \`env\` section checks every non-secret variable below against its kind and range and lists all problems in one report, never a value. The \`stack\` section runs the free, read-only probes of the five stack links, the same ones \`ultrathink stack\` runs without \`--live\`: no tokens are spent, the Hindsight and Realm probes send no key, and the Decisions link makes no request.
- \`ultrathink stack\` prints one line per stack link with its status, the reason and a fix line. ${STACK_LIVE_COST_LINE}.
- \`bun services/ultrathink/server.ts --check-config\` validates the hosted service's variables without starting it. It prints \`config ok\` and exits 0, or prints \`ultrathink: N configuration problems\` followed by one line per problem and exits 1. No line contains a secret value.

`;

const SCOPES: ReadonlyArray<{ scope: EnvScope; title: string; blurb: string }> = [
	{
		scope: "plugin",
		title: "Plugin variables",
		blurb:
			"Read by the hooks, `bin/ultrathink` and the other plugin commands, on every host. Includes the state and host paths.",
	},
	{
		scope: "service",
		title: "Hosted service variables",
		blurb:
			"Read only by the hosted service (`services/ultrathink`) at start. A bad value stops it, and `--check-config` lists every problem.",
	},
	{
		scope: "stack",
		title: "Stack variables",
		blurb:
			"Settings for the five stack links: Substrate, Swarm, Realm, Decisions and Hindsight. `ultrathink stack` reports their state.",
	},
];

const COLUMNS =
	"| name | aliases | secret | kind | default | description |\n| --- | --- | --- | --- | --- | --- |";

/** A table cell: one line, with the column separator escaped. */
function cell(text: string): string {
	return text.replace(/\r?\n/g, " ").replace(/\|/g, "\\|");
}

function code(text: string): string {
	return `\`${text}\``;
}

/** The kind plus whatever bounds the validator enforces, so the table says what a variable accepts. */
function kindCell(entry: EnvVarDef): string {
	const notes: string[] = [];
	if (entry.disableValue !== undefined) notes.push(`disabled by ${entry.disableValue}`);
	else if (entry.values) notes.push(`one of ${entry.values.join(", ")}`);
	if (entry.min !== undefined && entry.max !== undefined)
		notes.push(`${entry.min} to ${entry.max}`);
	else if (entry.min !== undefined) notes.push(`at least ${entry.min}`);
	else if (entry.max !== undefined) notes.push(`at most ${entry.max}`);
	return notes.length > 0 ? `${entry.kind} (${notes.join("; ")})` : entry.kind;
}

function rowOf(entry: EnvVarDef): string {
	const cells = [
		code(entry.name),
		entry.aliases?.length ? entry.aliases.map(code).join(", ") : "—",
		entry.secret ? "yes" : "no",
		cell(kindCell(entry)),
		entry.default === undefined ? "—" : code(cell(entry.default)),
		cell(entry.description),
	];
	return `| ${cells.join(" | ")} |`;
}

/** The whole docs/environment.md, ending in exactly one newline. */
export function renderEnvDocs(registry: readonly EnvVarDef[] = ENV_REGISTRY): string {
	const sections = SCOPES.map(({ scope, title, blurb }) => {
		const rows = registry.filter((entry) => entry.scope === scope).map(rowOf);
		return [`## ${title}`, "", blurb, "", COLUMNS, ...rows].join("\n");
	});
	return `${HEAD}${sections.join("\n\n")}\n`;
}

/** The file as committed, or undefined when it is missing. */
export function readCommittedEnvDocs(root: string = ROOT): string | undefined {
	try {
		return readFileSync(join(root, ENV_DOCS_FILE), "utf8");
	} catch {
		return undefined;
	}
}

if (import.meta.main) {
	const rendered = renderEnvDocs();
	if (process.argv.includes("--check")) {
		if (readCommittedEnvDocs() === rendered) {
			process.stdout.write(`${ENV_DOCS_FILE} is current\n`);
		} else {
			process.stderr.write(`${ENV_DOCS_FILE} is stale: run bun scripts/render-env-docs.ts\n`);
			process.exit(1);
		}
	} else {
		writeFileSync(join(ROOT, ENV_DOCS_FILE), rendered);
		process.stdout.write(`wrote ${ENV_DOCS_FILE}\n`);
	}
}
