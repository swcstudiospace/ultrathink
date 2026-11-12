# Install ultrathink in Omp

## Requirements

- Observed host: `omp/18.19.0` (`omp --version`).
- Minimum Omp version: not documented.
- The repo's dev dependency pins `@oh-my-pi/pi-ai ^18.14.0` (`package.json`). That pin is not a host minimum.
- Repo engine: `bun >=1.2` (`package.json` `engines`).

## Install

From a checkout of this repo:

```sh
omp plugin install --dry-run .   # prints "[dry-run] Would link ." and installs nothing
omp plugin install .
```

Omp also accepts an npm package, `github:org/repo#ref`, a git URL, or `plugin@marketplace`. This repo's `package.json` sets `"private": true`, so no npm-registry install is supplied. The repo ships `.omp-plugin/marketplace.json`, but a marketplace install was not exercised.

Scope: `--scope user` (default) or `--scope project`.

For development, link a checkout instead: `omp plugin link <path>`.

## Verify the install

```sh
omp plugin list
```

Inside Omp, the extension registers `/ultrathink-quick`, `/ultrathink-skip`, `/ultrathink-off`, `/ultrathink-on`, `/ultrathink-track`, `/ultrathink-status`, `/ultrathink-ui`, and `/ultrathink-swarm`. Confirm these from source; a live session was not run.

## Reload

Run `/reload-plugins` or restart Omp. Edits in a linked checkout take effect only after a reload or restart.

## Uninstall

```sh
omp plugin uninstall ultrathink
```

Add `--dry-run` to preview. The target name `ultrathink` comes from `package.json`; the uninstall help confirms the action and flags but not the exact target form.

The ultrathink state directory, `${PI_CODING_AGENT_DIR:-~/.omp/agent}/ultrathink`, is not documented as removed by uninstall. Delete it by hand for a clean slate.

## Permissions

The repo manifest declares no permissions. `package.json` only sets `omp.extensions` to `./src/host/omp.ts`. The extension's actual access, from the source:

- **Hooks and commands.** Registers slash commands and lifecycle hooks (`session_start`, `session_switch`, `session_shutdown`, `turn_start`, `tool_result`, `agent_end`, `before_agent_start`) to plan prompts and track turns. In TUI mode it draws a widget and dashboard.
- **Config reads.** `~/.config/ultrathink/config.json`, `~/.claude/ultrathink.json` (or `CLAUDE_CONFIG_DIR`), and the project layer `<cwd>/.claude/ultrathink.json`.
- **State writes.** Per-cwd state under `${PI_CODING_AGENT_DIR:-~/.omp/agent}/ultrathink`.
- **Git.** Runs `git` with a 2 s timeout for the ship precheck when ship applies.
- **Detached process.** Spawns a detached `teach observe` process from the agent-end path.
- **Tracker integrations.** Tracks Linear, Notion, and Greptile connection state. Network traffic was not traced for this doc.

## Known limitations

- Minimum Omp version is not documented.
- Only the `--dry-run` install was run. No real install, reload, or uninstall was executed here.
- Marketplace install is not exercised.
- Uninstall's effect on the state directory is not documented.
- Command list and permissions come from source, not a live Omp session.

## Sources

`.planning/research/hosts/host-contracts.md`, section 1 (Omp), citing S-OMP-SRC (`src/host/omp.ts`), S-OMP-PKG (`package.json`), S-OMP-PATHS (`src/host/paths.ts`), S-OMP-CLI (local `omp` help and dry run), S-OMP-EXT (https://omp.sh/docs/extension-authoring), S-OMP-PLG (https://omp.sh/docs/plugins), S-OMP-MKT (https://omp.sh/docs/marketplace).
