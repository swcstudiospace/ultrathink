# Install ultrathink in Claude Code

## Requirements

- Claude Code: observed 2.1.322 on the check host. The official docs record no base version for the plugin system. Feature minimums: 2.1.275 for the `--marketplace` install form, 2.1.292 for shell install (`claude plugin install`).
- Bun: the hooks and the `bin/` CLIs run through `bin/run-bun`. Without Bun, hooks exit 0 (no-op) and the CLIs exit 127 with an install hint.

## Install

Add the marketplace, then install the plugin:

```sh
claude plugin marketplace add swcstudiospace/claude-ultrathink
claude plugin install ultrathink@ultrathink --scope user
```

Equivalent single command:

```sh
claude plugin install ultrathink --marketplace swcstudiospace/claude-ultrathink --scope user
```

In a session, `/plugin install ultrathink@ultrathink` opens the details panel.

Scopes: `user` (default), `project`, `local`.

For a local checkout without installing, load the plugin for one session:

```sh
claude --plugin-dir /path/to/claude-ultrathink
```

## Verify the install

```sh
claude plugin list
```

Maintainers can check the manifest locally from the repo root with `claude plugin validate .`. It passes with one `ICON_MISSING` warning.

## Reload

Run `/reload-plugins` in a running session, or start a new session.

## Uninstall

```sh
claude plugin uninstall ultrathink
```

In a session: `/plugin uninstall`. Removing the last scope deletes the plugin data directory `~/.claude/plugins/data/<id>/`, except for the exceptions listed in the CLI reference.

## Permissions

The manifest declares no `userConfig`, so nothing is prompted at install.

Hooks (`hooks/hooks.json`) run as your user on these events:

- `UserPromptSubmit`: `hooks/uplift.ts` plans each prompt (timeout 86400 s).
- `PostToolUse`: `hooks/answers.ts` on `AskUserQuestion`; `hooks/pr-sync.ts` and `hooks/flow-eval.ts` on shell-type tools; `hooks/flow-eval.ts` on `Skill`; `hooks/pr-sync.ts` on pull-request creation tools.
- `Stop`: `hooks/stop.ts`.

Each hook gets `CLAUDE_PLUGIN_ROOT` and `CLAUDE_PLUGIN_DATA`. The plugin ships no `.mcp.json`.

## Known limitations

- The docs conflict on update behavior: `claude plugin update` help says a restart is required; the install doc says `/reload-plugins`. Do both to be safe.
- No base Claude Code version is documented. The minimums above are feature-level only.
- The hooks execute code on every prompt and every shell or PR tool call. Install only from sources you trust.
- The plugin tracks work in Linear and Notion and gates PRs through Greptile. Those services are not configured by the plugin manifest.

## Sources

- Contract: `.planning/research/hosts/host-contracts.md`, section "4. Claude Code" (S-CC-PLUG, S-CC-REF, S-CC-INST, S-CC-COMP, S-CC-CREATE, S-CC-CLI, S-CC-MODS, S-CC-LOCAL, S-CC-REPO).
- Repo: `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `hooks/hooks.json`, `bin/run-bun`.
