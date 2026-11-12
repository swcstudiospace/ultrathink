# Install ultrathink in Prime Agent

## Requirements

- Prime Agent 0.10.2 (installed release); minimum version not documented.
- Bun 1.2+, Python 3.10+ (`requires-python`), and a full clone of claude-ultrathink (`ULTRATHINK_PLUGIN_ROOT` overrides its location).
- Claude CLI is the default planning engine; `grok` and `muse` need their CLI logged in.
- Optional tracking: `bin/ultrathink-mcp auth login linear|notion` in the clone.

## Install

Verified usage (`prime-agent package install --help`):

```sh
prime-agent package install <source> [--local]
```

`--local` installs into the current project instead of the user configuration.

`<source>` syntax is UNVERIFIED for 0.10.2: help lists no source kinds, and Prime Agent's public README `npm:` examples predate the Rust build. Do not guess; see Known limitations.

The repo's setup-script route: see `docs/install.md#prime-agent`. The host contract does not cover it.

## Verify the install

```sh
prime-agent package list
```

Confirm the package is listed. In a fresh session, `/skill:ultrathink` loads the entry; then `/ultrathink-status` reports the planner state without planning.

## Reload

Skills load at startup: start a fresh session after installing, and after `prime-agent update`. The skill-creator documents `/reload` for new skills; not tested here.

## Uninstall

```sh
prime-agent package remove <source> [--local]
```

`--local` removes from the current project configuration. Effect on the state directory is not documented.

## Permissions

- No skill sets `allowed-tools` (pre-approved tools); no package prompts are documented.
- `pyproject.toml`: no Python dependencies; one console script, `ultrathink` (`rlm.skill:cli`).
- Python-backed entry (python-skills reference): installed editable into the kernel venv (`~/.prime/agent/kernel-venv` by default) and exposed as `ultrathink`; its workflow uses `rlm.spawn`. Not observed here.
- Runtime: runs the shared engine from the clone, reads the ultrathink config files, keeps state under `${PRIME_AGENT_CODING_AGENT_DIR:-~/.prime/agent}/ultrathink/`, and uses the MCP gateway login for tracking.

## Known limitations

- Skills only: no hook or command-registration API, so `/ultrathink-*` is not a registered slash command and nothing plans per prompt.
- The entry's control table maps those words, except `/ultrathink-quick`, to `ultrathink.ctl(...)`, so they work only while the agent follows that skill. The six `commands/<name>/SKILL.md` files are not under a documented skills directory, so `/skill:ultrathink-<name>` is UNVERIFIED.
- Layout UNVERIFIED: documented package skill locations (npm packages) are `skills/` or `pi.skills`; this folder has neither.
- Name mismatch: the folder is `hosts/prime-agent`, the skill `ultrathink`; the skill-creator says that warns but loads. The setup-script route links it as `ultrathink`.
- Not tested here: `prime-agent --skill <path>` (per `--help`), and copying `SKILL.md` alone into `~/.prime/agent/skills/ultrathink/` (the entry is Python-backed).
- The entry directs the agent to `ultrathink-kickoff`, `ultrathink-sync` and `ultrathink-ship`. This folder does not ship them; the package route's provision of them is UNVERIFIED.
- Not documented for 0.10.2: minimum version, package data directory, package prompts. Source kinds UNVERIFIED.

## Sources

- Host contract `.planning/research/hosts/host-contracts.md`: section 3 and its unverified-gaps list.
- S-PA-CLI: `prime-agent --help`, `package --help`, `package install --help`, `package remove --help`.
- S-PA-SC: bundled skill-creator `SKILL.md`, `references/python-skills.md`.
- S-PA-HOST: `hosts/prime-agent/SKILL.md`, `commands/*/SKILL.md`; `pyproject.toml` (read for Permissions).
- S-PA-REPO (public docs return 404), S-PA-RT, S-PA-BIN: as recorded in the contract.
