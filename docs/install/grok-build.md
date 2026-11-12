# Install ultrathink in Grok Build

## Requirements

- Grok Build 1.0.77 observed (`grok --version`). Minimum version: not documented.
- Bun 1.2 or later (repo launcher); without it, hooks exit 0. Bun 1.3.3+ keeps repo `.env*` files out via `--no-env-file`; older Bun loads them.

## Install

```
grok plugin install <path-to-checkout> [--trust]
```

`SOURCE` also accepts a git URL or `user/repo` (help text); this doc covers only the local path. Without `--trust`, Grok asks first. Skills, hooks, and MCP servers stay inactive until the plugin is trusted. Add `--trust` only for a checkout you trust. Grok reads `.claude-plugin/plugin.json`; this repo has no `.grok-plugin/` manifest.

## Verify the install

- `grok plugin list` (contract command). Whether a local-path install appears is unverified.
- `grok plugin details ultrathink` (component inventory). Check for skills, commands, and hooks; the output format is undocumented.

## Reload

Open `/plugins` in a running session and press `r` in the Plugins tab, or start a new session. Source: bundled text; not exercised.

## Uninstall

```
grok plugin uninstall ultrathink
```

`--keep-data` preserves the plugin's data directory, so the default removes it (inferred from help text). `grok plugin disable ultrathink` turns the plugin off without uninstalling.

## Permissions

Trust gates everything below. The repo declares no MCP servers, user config, or `allowed-tools`; `.mcp.json` is not tracked. Hooks in `hooks/hooks.json` run through `bin/run-bun`:

- UserPromptSubmit: `uplift.ts` plans each prompt (timeout 86400 s).
- PostToolUse `AskUserQuestion`: `answers.ts` folds answers into the session's clarifications and spec.
- PostToolUse shell and PR-creation tools: `pr-sync.ts` nudges `ultrathink-sync` after PR creation in a planned session.
- PostToolUse shell and `Skill`: `flow-eval.ts` scores gsd-autonomous and phase output through OpenRouter, only when a key is set and `ULTRATHINK_DECISIONS` is not `0`.
- Stop: after a tracked task's turn, `stop.ts` nudges `ultrathink-sync`. With Teachable Moments capture `observe` or `auto`, it passes the transcript to a detached `teach observe`.

`pr-sync.ts` and `stop.ts` never call Linear or Notion. The agent makes those writes through MCP servers the plugin does not bundle (per the skill descriptions).

## Known limitations

- Minimum version: not documented.
- Manifest paths: bundled text lists `.grok-plugin/`, `.claude-plugin/`, and `.cursor-plugin/` manifests, none under `.grok/`; `.claude-plugin/` is accepted, not a fallback. Precedence is undocumented.
- `.grok/`: commit `01c6ee7` deleted `.grok/agents/` and `.grok/hooks/agent-swarm.json`. `.grok/config.toml` remains tracked as an MCP config; whether Grok loads it is unverified.
- `${CLAUDE_PLUGIN_ROOT}`: the contract lists only the `GROK_` variables. Bundled text says the `CLAUDE_` aliases are set too. Not exercised.
- Payloads: `src/host/envelope.ts` maps Grok's camelCase stdin keys (read, not run). `run_terminal_command` (named in Grok's hook example) matches the shell matcher. `Skill`, `AskUserQuestion`, and PR-creation matchers are unverified on Grok.
- `additionalContext` is dropped for MCP calls from Execute cells and workflows (bundled text). `pr-sync.ts` and `flow-eval.ts` depend on it.
- Not run here: install, reload, enable, disable, or any hook.

## Sources

- `.planning/research/hosts/host-contracts.md` section 5 (lines 173-200), keys S-GK-DOC, S-GK-HK, S-GK-MKT, S-GK-LOCAL.
- Bundled text in the local `grok-native` binary; local `grok` help; repo files named above.
