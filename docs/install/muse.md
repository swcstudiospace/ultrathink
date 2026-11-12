# Install ultrathink in Muse Code

## Requirements

- Observed on Muse Code 1.4.14. The local release channel reports 1.4.15 as latest.
- Minimum supported Muse version: not documented. Community reports of plugin support from 1.3.0 are unverified.
- The hooks run through `bin/run-bun`. Their scripts exit 0 when `bun` is missing, so prompts proceed with no planning and no error.

## Install

Run from the repo root. Muse selects `.muse-plugin/plugin.json` there.

```sh
muse plugins install . --scope user
muse plugins approve ultrathink
```

- `--scope` accepts `user` or `project`. The help does not state a default.
- The plugin ID is the manifest name, `ultrathink`. Confirm it with `muse plugins list`.
- `approve` trusts and enables the runtime capabilities. Whether `install` alone enables them was not verified.
- Marketplace form: `muse plugins install ultrathink@<marketplace>` after `muse plugins marketplace add`.

## Verify the install

```sh
muse plugins list
muse plugins inspect ultrathink
```

## Reload

Start a new session; Muse documents that hook changes load then. `enable` and `disable` apply "for future runtime loads". Reloading inside a running session is not documented.

## Uninstall

```sh
muse plugins remove ultrathink
```

`--delete-data` is accepted. The help does not say what it deletes, and the plugin data directory is not documented.

## Permissions

`.muse-plugin/plugin.json` declares 5 skills, 6 commands, and 3 hooks, with no MCP servers, reminders, or agents. The hooks set `ULTRATHINK_HOST=muse` and run through `bin/run-bun`:

| Event | Script | Timeout | Purpose |
|---|---|---|---|
| `UserPromptSubmit` | `hooks/muse-prompt` runs `hooks/uplift.ts` | 600000 ms | Plans each prompt with the ultrathink engine |
| `PostToolUse` | `hooks/muse-post-tool` runs `hooks/pr-sync.ts` | 10000 ms | PR sync check; no matcher, so it sees every tool call and filters to PR creation |
| `Stop` | `hooks/muse-stop` runs `hooks/stop.ts` | 5000 ms | Sync nudge |

Muse documents that hooks run outside the sandbox and approval policy. Install only plugins you trust.

## Known limitations

- Muse has no public bundle specification. `.muse-plugin` support is observed from the binary and validator only.
- When both `.muse-plugin/plugin.json` and `.claude-plugin/plugin.json` exist, Muse selects `.muse-plugin` and ignores `.claude-plugin` (`multiple-manifests` warning). Claude Code and Grok Build still read `.claude-plugin`.
- Validate from the repo root. `muse plugins validate .muse-plugin` fails with `missing-manifest`.
- Repo-root validation reports `diagnostics=2`: the precedence warning and a symlink warning for `hosts/prime-agent/.venv/bin/python`, which escapes the package root. The plugin still validates. That path is inside `hosts/prime-agent/.venv/`, a local-only virtualenv that `hosts/prime-agent/.gitignore` excludes (`.venv/`). It is not part of the repo.
- Experimental gate: community reports and a secondary realm-build snippet say plugin commands need `MUSE_EXPERIMENTAL_PLUGINS=1`. Validate and list ran without it. Install and approve were not tested with or without it.
- Minimum Muse version and plugin data directory: not documented.

## Sources

- `host-contracts.md`, section 6 (Muse Code), keys S-MU-LOCAL, S-MU-REPO, S-MU-EXT, S-MU-CFG, S-MU-REL. S-MU-SNIP is secondary and was used only as a lead.
- Repo files: `.muse-plugin/plugin.json`, `hooks/muse-prompt`, `hooks/muse-post-tool`, `hooks/muse-stop`, `hosts/prime-agent/.gitignore`.
