# Prime Agent validation run

Host: Prime Agent
Date (YYYY-MM-DD): 2026-11-13
Host version: `prime-agent -v` → `0.10.2`
Checkout: branch plugin-core-slice, commit d455baf
Tester: MatrixPrimeAgent (automated worker, isolated HOME)
Pass or fail: **Fail (blocked at step 2: install source syntax UNVERIFIED; no install performed)**

## Isolation

Root: `/tmp/ut-matrix/prime-agent/`, `HOME=/tmp/ut-matrix/prime-agent/home`, `PRIME_AGENT_CODING_AGENT_DIR=/tmp/ut-matrix/prime-agent/home/.prime/agent`.

Evidence: step 1 (`prime-agent package list`, run before any mutating command) printed `No packages installed.` under the isolated env, so no operator package is visible. Isolation honored.

## Steps

### Step 1: `prime-agent package list`
```
$ prime-agent package list
No packages installed.
exit=0
```
Package not listed.

### Pre-step-2 source-syntax check (read-only)
```
$ prime-agent package install --help
Usage:
  prime-agent package install <source> [--local]

Install a capability package.

Options:
  --local  Install into the current project instead of the user configuration
exit=0
```
```
$ prime-agent help package
Usage:
  prime-agent package <install|remove|list|update>

Manage capability packages.

Packages can provide skills, prompts, and themes.

Commands:
  install  Install a capability package
  remove   Remove a capability package
  list     List installed capability packages
  update   Update capability packages
exit=0
```
```
$ prime-agent --help
(excerpt; full output is 60+ lines. Kept: the usage header and the Commands list, where `package    Manage capability packages` is the only package entry. The `--skill <path>` option loads a skill, not a package source.)
exit=0
```
Neither the install help nor the package help documents a local-path source form. No source was guessed.

### Step 2: `prime-agent package install <source> [--local]`
NOT RUN. Blocker: the `<source>` syntax is not documented by the installed binary (0.10.2) or the install doc (`docs/install/prime-agent.md`, "UNVERIFIED for 0.10.2"). No source value was guessed.

### Steps 3–9
NOT RUN. Steps 3–8 depend on a successful install. Step 9 follows the same stop point. Stopped per the assignment.

## Lifecycle states

Install
- `not_installed`: observable (step 1 does not list the package).
- `installing`: not observable on this host (no progress output documented).
- `installed`: not observed (step 2 not run; step 3 not run).
- `install_failed`: not observed (step 2 not invoked, so no failure output).

Load
- `loading`: not observable on this host.
- `loaded`: not observed (step 5 not run).
- `version_mismatch`: not observable on this host.
- `capability_missing`: not observable on this host.
- `load_failed`: not observable on this host.

Invoke
- `idle`: not observed (step 6 not run).
- `running`: not observable on this host.
- `awaiting_user_decision`: not observable on this host.
- `succeeded`: not observable on this host.
- `failed`: not observable on this host.
- `cancelled`: not observable on this host.

## Install command
None executed. Documented form: `prime-agent package install <source> [--local]`; `<source>` is unknown.

## Final `list` output
`prime-agent package list` → `No packages installed.` (step 1; the post-install list was not run).

## Notes
- Blocker (verbatim, step 2): `Usage: prime-agent package install <source> [--local]` with no source-kind description.
- The isolated home was created empty; nothing was installed, removed, enabled, or approved. No real-home command was run.
- Repo files changed: only this results file.

## Install syntax verified on 0.10.2 (local path, isolated home)

Date: 2026-11-14. Prime Agent `0.10.2`. Isolated `HOME=/tmp/pa-verify/home`, `PRIME_AGENT_CODING_AGENT_DIR` inside it. Package: a throwaway `package.json` (`pa-probe` 0.0.1) in `/tmp/pa-verify/pkg`, deleted afterward.

- `prime-agent package list` → `No packages installed.`
- `prime-agent package install /tmp/pa-verify/pkg` → `Installed /tmp/pa-verify/pkg`, exit 0. List then shows the local path under `User packages`.
- `prime-agent package remove /tmp/pa-verify/pkg` → `Removed /tmp/pa-verify/pkg`, exit 0. List returns to `No packages installed.`

Verified form on 0.10.2: `prime-agent package install <absolute-path>`. The published README (found by web search) also documents `npm:<pkg>[@version]`, `git:<repo>[@ref]`, `https://…`, `ssh://…`, and a checkout via `"$PWD"`. The npm and git forms were not run here (they need the network, and an unknown package would run full-access code). Not verified: load, invoke, and that the packaged command runs after install.
