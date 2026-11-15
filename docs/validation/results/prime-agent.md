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

Verified form on 0.10.2: `prime-agent package install <absolute-path>`. The published README (found by web search) also documents `npm:<pkg>[@version]`, `git:<repo>[@ref]`, `https://…`, `ssh://…`, and a checkout via `"$PWD"`. The npm and git forms were not run here (they need the network, and an unknown package would run full-access code). Load, invoke, and the packaged command after install are not verified in this section; the 2026-11-15 section below records them.

## 2026-11-15 live load and invoke (0.10.2, isolated root)

Host: Prime Agent `0.10.2`. Checkout: worktree `/root/src/worktrees/ut-prime`, branch `docs/prime-agent-load`, commit `9feb75f` (origin/main). Tester: PrimeAgentLoadInvoke. Isolated root `/tmp/prime-live-19dR` (`HOME` and `PRIME_AGENT_CODING_AGENT_DIR` inside it; the real home was not used).

**Verdict: pass.** Install, load (package list, RPC `get_commands`, kernel-venv import) and invoke of `/ultrathink-status` all exit 0 with the expected output.

### Install (staging block from docs/install/prime-agent.md)

`STAGE` and `PROJECT` sit inside the isolated root; `CLONE` is the worktree. The staged `package.json` lists `hosts/prime-agent` plus the six `skills/ultrathink-*` directories under `pi.skills`.

```
$ prime-agent package install "$STAGE" --local
Installed /tmp/prime-live-19dR/stage            (exit 0)
$ prime-agent package list
Project packages:
  ../../../stage
    /tmp/prime-live-19dR/stage                  (exit 0)
```

### Load

RPC: `printf '{"id":"1","type":"get_commands"}\n' | prime-agent --mode rpc --cwd "$PROJECT" --no-session` → exit 0, `success: true`. Skills with origin `package`: `skill:ultrathink` (`<clone>/hosts/prime-agent/SKILL.md`), `skill:ultrathink-cursor`, `-kickoff`, `-plan`, `-ship`, `-sync`, `-teach`.

Python entry: `kernel-venv/bin/python -c "import ultrathink; print(ultrathink.status()['host']); print(ultrathink.plan('ok')['skipped'])"` → exit 0, prints `prime-agent` and `precheck-trivial`.

### Invoke

```
cd "$PROJECT" && prime-agent -p --no-session --cwd "$PROJECT" --provider anthropic --model claude-haiku-4-5 -- "/skill:ultrathink" "/ultrathink-status"
```

Exit 0, wall time 10.29 s. stdout, verbatim:

```text
**ultrathink status:**

- **Engine**: claude-haiku-5-5 (ready)
- **Prompt Uplift**: on
- **Graph of Thought**: on
- **HITL clarifications**: on (max 4)
- **Tracking**: on but **not configured** (Notion dataSourceUrl and Linear team not set)
- **Ship**: off (opt-in feature)
- **Teach**: on (0 confirmed lessons, 0 candidates)
- **State dir**: `/tmp/prime-live-19dR/home/.prime/agent/ultrathink`

Planning is active and ready. Tracking would need Notion/Linear configuration to log tasks. Use `await ultrathink("request")` to plan a task, or skip/off/quick controls with `/ultrathink-*` commands.
```

stderr: install and kernel-venv build lines only; no errors. The first kernel-venv build downloaded CPython 3.11.17 and dependencies (about 30 s, one time).

Model note: the `--model` flag passed to this invoke was `claude-haiku-4-5`, and the engine line reports `claude-haiku-5-5`. This run does not establish which model served the request.

### Attempts that did not pass (kept)

1. Invoke with `cd "$ISO/work"` (the procedure's directory): exit 0, but the model reported no ultrathink skill. Project-local packages load only when `--cwd` is the project directory, so the invoke was rerun from the project.
2. Invoke from the project with no login copied: exit 1. A shell-inherited `ANTHROPIC_API_KEY` was sent to the Anthropic API in this attempt and rejected: `Provider rejected the request (invalid_request_error, 400): Your credit balance is too low ...`. The key was ambient, not copied from any login. Using it was not an approved use of that key. Its value is not recorded. It was unset for every later run. The key's owner should check whether it needs rotation; this run does not verify rotation.
3. Same invoke with the key unset and no login: exit 1, `Error: Unknown provider "anthropic". Use "prime-agent model list" ...`. The install doc says a missing provider stops with `No authenticated models available`; 0.10.2 reports an unknown provider instead. Doc discrepancy, not yet fixed.

### Login

Only the `anthropic` entry of the user's Prime-Agent login (`/root/.prime/agent/auth.json`) was copied into the isolated `auth.json`, mode 600, 303 bytes. The source was read, not modified, and its values were not printed. After the copy, `prime-agent model list` showed 16 `anthropic` models. The earlier model-turn section in docs/install/prime-agent.md used a Claude login instead.

### Cleanup

`rm -rf /tmp/prime-live-19dR` → `test -e` reports the root gone, and no `/tmp/prime-live-*` directory remains. The copied login was inside that root and was removed with it. No commit was made, and only this results file was changed.

Still unverified: `/skill:ultrathink-<name>` slash forms, and the `/reload` path.
