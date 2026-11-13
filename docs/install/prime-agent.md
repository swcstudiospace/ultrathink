# Install ultrathink in Prime Agent

## Requirements

- Prime Agent 0.10.2 (installed release); minimum version not documented.
- Bun 1.2+, Python 3.10+ (`requires-python`), and a full clone of claude-ultrathink (`ULTRATHINK_PLUGIN_ROOT` overrides its location).
- Claude CLI is the default planning engine; `grok` and `muse` need their CLI logged in.
- Optional tracking: `bin/ultrathink-mcp auth login linear|notion` in the clone.

## Install

Prime Agent installs a capability package with `prime-agent package install <source> [--local]`. `--local` installs into the current project instead of the user configuration (the user-configuration route is not tested here).

### Source forms accepted by 0.10.2

| Source | Result | Evidence |
|---|---|---|
| Local path, absolute (`/abs/dir`) or relative (`./dir`, `dir`) | Accepted; a directory installs. A missing path fails with `Error: Path does not exist: <resolved path>` | Observed. The release usage strings include `package install ./local/path` |
| `npm:<name>` | Accepted; runs `npm install` into `<project>/.prime/agent/npm` | Observed (npm 404 for a bogus name) |
| `git:<host>/<path>`, `git:git@<host>:<path>`, `https://…`, `ssh://…` | Accepted; runs `git clone` into `<project>/.prime/agent/git/<host>/<path>` | Observed (`repository not found`; ssh permission denied) |
| `file:///path` | Not a URI form: treated as a relative path and fails with `Path does not exist` | Observed |
| `github:`, `gitlab:`, `bitbucket:`, `gist:` shorthands | Their host strings are in the binary; not exercised | UNVERIFIED |

Code evidence: the 0.10.2 binary (`/root/.local/share/prime-agent/releases/0.10.2-linux-x64-*/prime-agent`) carries the package source parser's module path `crates/pa-core/src/packages/source.rs` and the install usage strings above (`grep -a 'package install' prime-agent`). The release build keeps no line numbers, so no per-line citation exists; the table rests on the observed behaviour above.

### Which source ships ultrathink

A package provides skills only through its `skills/` directory or the `pi.skills` paths in its `package.json`. The installed `skills/skill-creator/SKILL.md:23` says so, and the release loads both. Two checks in the isolated root decide the form:

- A `package.json` with a `pi` key but no `pi.skills` turns off `skills/` discovery. The clone root is such a package (`"pi": {"extensions": …}`), so installing the clone root directly loaded none of the ultrathink skills.
- A `package.json` with `"pi": {"skills": [ … ]}` loads each listed directory. Installing that manifest loads `ultrathink` from `hosts/prime-agent/SKILL.md` and the six `ultrathink-*` skills from `skills/`, with no copies.

So the source is a small staging directory outside the clone whose only file is that manifest. Run it with `--local` from the project directory:

```sh
CLONE=<clone>        # absolute path of the checkout
STAGE=<stage>        # any directory outside the clone
PROJECT=<project>    # the project --local installs into
mkdir -p "$STAGE"
{
  printf '{"name":"ultrathink-checkout","version":"1.4.0","pi":{"skills":["%s/hosts/prime-agent"' "$CLONE"
  for d in "$CLONE"/skills/*/; do printf ',"%s"' "${d%/}"; done
  printf ']}}\n'
} > "$STAGE/package.json"
cd "$PROJECT" && prime-agent package install "$STAGE" --local
```

`--local` writes `<project>/.prime/agent/settings.json`. Skills load from the checkout, so `git pull` updates them.

## Verify the install

```sh
prime-agent package list
```

Confirm `Project packages:` lists the staging directory.

Confirm the skills load. A headless RPC session lists them (`prime-agent --mode rpc --cwd "$PROJECT" --no-session`, then `{"id":"1","type":"get_commands"}`). The result holds `skill:ultrathink` with `sourceInfo.path` at `<clone>/hosts/prime-agent/SKILL.md` and origin `package`, plus `skill:ultrathink-cursor`, `-kickoff`, `-plan`, `-ship`, `-sync` and `-teach`.

Confirm the Python entry without a model turn, using the kernel venv (`~/.prime/agent/kernel-venv`):

```sh
PRIME_AGENT_CODING_AGENT_DIR=<dir> <dir>/kernel-venv/bin/python -c \
  "import ultrathink; print(ultrathink.status()['host']); print(ultrathink.plan('ok')['skipped'])"
```

It prints `prime-agent` and `precheck-trivial`. `ultrathink.ctl("status")` returns the planner state that `/ultrathink-status` reports.

Verify a model turn: `/skill:ultrathink` and `/ultrathink-status` in a fresh session. This needs a configured model provider (see Known limitations).

## Reload

Skills load at startup: start a fresh session after installing, and after `prime-agent update`. The skill-creator documents `/reload` for new skills; not tested here.

## Uninstall

```sh
prime-agent package remove "$STAGE" --local
```

Observed: `Removing <stage>...` then `Removed <stage>`; `prime-agent package list` then prints `No packages installed.`, and the RPC listing has no ultrathink entries. The removal leaves `${PRIME_AGENT_CODING_AGENT_DIR:-~/.prime/agent}/ultrathink/` (state) and the kernel venv's `_editable_impl_ultrathink.pth` in place. Delete the staging directory yourself.

## Permissions

- No skill sets `allowed-tools` (pre-approved tools); no package prompts are documented.
- `pyproject.toml`: no Python dependencies; one console script, `ultrathink` (`rlm.skill:cli`).
- Python-backed entry: the package install put `_editable_impl_ultrathink.pth` in the kernel venv (`~/.prime/agent/kernel-venv`), pointing at `<clone>/hosts/prime-agent/src`. `import ultrathink` resolves to the clone. Calling `await ultrathink("…")` relies on the kernel's `run()` wrapping (`skills/skill-creator/references/python-skills.md`, "The run() Convention"); not exercised in a model turn.
- Runtime: runs the shared engine from the clone, reads the ultrathink config files, keeps state under `${PRIME_AGENT_CODING_AGENT_DIR:-~/.prime/agent}/ultrathink/`, and uses the MCP gateway login for tracking.

## Known limitations

- Skills only: no hook or command-registration API, so `/ultrathink-*` is not a registered slash command and nothing plans per prompt.
- The entry's control table maps those words, except `/ultrathink-quick`, to `ultrathink.ctl(...)`, so they work only while the agent follows that skill. The six `commands/<name>/SKILL.md` files are not in the recipe and are not under a documented skills directory, so `/skill:ultrathink-<name>` for them is UNVERIFIED.
- The install directory is `hosts/prime-agent`; the skill's name is `ultrathink` from its frontmatter. The package route loaded it with no warning on stderr.
- Model turn not verified: with no provider configured the headless run stops before the skill runs, `Error: No authenticated models available. Configure a provider or select a model explicitly.`. With a placeholder provider at an unreachable endpoint it reaches the model call and stops with `Connection error.`.
- Not tested here: `prime-agent --skill <path>` (per `--help`), copying `SKILL.md` alone into `~/.prime/agent/skills/ultrathink/` (the entry is Python-backed), and the user-configuration install (no `--local`).
- Not documented for 0.10.2: minimum version, package data directory, package prompts. The `github:`, `gitlab:`, `bitbucket:` and `gist:` source shorthands are UNVERIFIED.

## Sources

- The 0.10.2 release binary: source parser module path `crates/pa-core/src/packages/source.rs`; install usage strings.
- The installed `skills/skill-creator/SKILL.md:23` and `references/python-skills.md` (the "The run() Convention" section).
- Observed runs in the isolated root `/tmp/ut-matrix/prime-agent-fix`: install, RPC `get_commands`, kernel-venv import, `ultrathink.status()`, `ultrathink.plan("ok")`, and removal, as described above.
- Host contract `.planning/research/hosts/host-contracts.md`: section 3 and its unverified-gaps list.
- `docs/install.md#prime-agent` covers the setup-script route (`scripts/setup.ts apply` symlinks), which is separate from this package route.
