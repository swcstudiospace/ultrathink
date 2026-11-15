# Hermes minimum version: validation record

Date: 2026-11-15
Floor under test: v0.23.1 (`adapters/version-floor.ts:16`)
Plugin under test: `hosts/hermes/` from origin/main `651e9fc`, installed as per-file symlinks (`docs/install/hermes.md`).
Checkout: worktree `/root/src/worktrees/ut-min-hermes`, branch `docs/min-version-hermes`. No commit.

## Result

**Latest (2026-11-15, Python 3.12): none validated. v0.23.1 (the floor) did not install a working host on Python 3.12: the packaged install omits every core dependency there (all 45 are gated to `python_version >= '3.14'`), so the lifecycle was not reached. The chain stopped at v0.23.1. See the dated section at the end.**

**None validated.** On Python 3.14.8, the lifecycle passed on every tested release from v0.21.5 through v0.23.1 (v0.21.5, v0.21.6 and v0.21.7 added 2026-11-15; see the dated section below). On Python 3.12, the v0.23.1 attempt failed at enable and list (exit 1); the plugin was never reached, and the failure is attributed to the dependency gate in the record. The 3.14.8 runs record no failing release, so the rule for a validated minimum (the next lower release fails) is not met, and the lowest passing tested release (v0.21.5, tag `v2026.9.24`) is not a validated minimum. The fallback ("lowest tested release if no lower release is installable offline") does not apply: lower official releases are installable from GitHub. The original sweep was stopped on the main agent's instruction at v0.22.0.

Python: every run before the 2026-11-15 Python 3.12 section used Python 3.14.8 (see "Python per run" under Sources and method). The only Python 3.12 run is the dated section at the end, which covers v0.23.1 only. The file records a declared range only for v2026.9.24 (`>=3.11,<3.14`); 3.14.8 is outside it, so that tag was not run on a declared-range Python. The declared range is not recorded in this file for the other tags (v0.21.6, v0.21.7, v0.22.0 to v0.23.1), so their range status is unverified.

Untested lower releases: v0.21.4 (`v2026.9.21`, which its release page titles "Hermes Agent v0.21.4") and earlier calendar tags. No `v0.21.5` git tag exists; the release titled "Hermes Agent v0.21.5" is tag `v2026.9.24`.

## Sources and method

- Releases: official tags of `github.com/NousResearch/hermes-agent`, cloned with `git clone --depth 1 --branch <tag>`. The npm `hermes-agent` and PyPI `hermes-agent` packages are third-party bridges and were not used.
- Install per tag: `uv venv --python 3.14.8` (Python fetched into the prefix), then `uv pip install -e <checkout>`. The non-editable install refuses to build, so the editable install was used. The operator's install uses Python 3.14.9; this run used 3.14.8.
- Python per run (from each section's `uv venv --python` line):
  - Sweep, v0.22.0 to v0.23.1 (the ten rows in the results table): `3.14.8` for every tag. The file does not record a declared `requires-python` for these tags, so their range status is unrecorded.
  - Gap run, v0.21.7, v0.21.6, and v2026.9.24 (titled v0.21.5): `3.14.8` for every tag (gap run method). For v2026.9.24 the declared range is `>=3.11,<3.14`, so 3.14.8 is outside it. The file does not record the declared range for v0.21.6 or v0.21.7.
  - Python 3.12 was used only in the 2026-11-15 dated section at the end of this file (v0.23.1). No other run used 3.11 to 3.13.
- Isolation: each run used `HOME=<prefix>/home/<tag>` and `HERMES_HOME=<that>/.hermes`, and every `hermes` command ran under `env -i PATH TERM LANG HOME HERMES_HOME`. No credential was copied or inherited. The real `/root/.hermes` was not touched.
- Model setup (placeholder, no model call can succeed): `model.provider=custom`, `model.base_url=http://127.0.0.1:9/v1`, `model.default=ut-minver-placeholder`, `telemetry.enabled=false`.
- Lifecycle per tag:
  1. install: `ln -sf` each `hosts/hermes/*.py` (skipping `*_test.py`) and `plugin.yaml` into `$HERMES_HOME/plugins/ultrathink`;
  2. enable: `hermes plugins enable ultrathink`;
  3. load: `hermes plugins list --plain` shows `enabled user 1.4.0 ultrathink`;
  4. invoke: `/ultrathink-lessons` in an interactive `hermes chat` under a pty. The driver answers the first-run "Help improve Hermes" and "Enable auto-prune?" prompts. Pass = output contains `No lessons saved yet.`;
  5. uninstall: `hermes plugins remove ultrathink`; then the isolated gateway processes are stopped.
- Headless invoke (`hermes chat -q '/ultrathink-lessons' --oneshot`) did not run the command on any tested release. It returned exit 0 with `Query: /ultrathink-lessons` (v0.22.0, v0.22.1, v0.22.3–v0.22.7, v0.23.0, v0.23.1), or hit the 180 s timeout, exit 124 (v0.22.0, v0.22.2). Invoke evidence is the pty route only.

## Results

Exit statuses are from `lifecycle.sh` per tag (install = per-file links; enable, list, remove = `hermes plugins` exit codes). The pty column is the driver result.

| Tag | `hermes --version` | install | enable | list (load) | pty invoke | remove | Verdict |
|---|---|---|---|---|---|---|---|
| v0.23.1 (floor) | `v0.23.1 (2026.9.24) · local 3b4215785882` | 0 | 0 | 0 | pass | 0 | pass |
| v0.23.0 | `v0.23.0 (2026.9.24) · local 2bd378ed1b8d` | 0 | 0 | 0 | pass | 0 | pass |
| v0.22.7 | `v0.22.7 (2026.9.24) · local b200f5bc60e3` | 0 | 0 | 0 | pass | 0 | pass |
| v0.22.6 | `v0.22.6 (2026.9.24) · local f0d94882e89a` | 0 | 0 | 0 | pass | 0 | pass |
| v0.22.5 | `v0.22.5 (2026.9.24) · local bf0203a794a0` | 0 | 0 | 0 | pass | 0 | pass |
| v0.22.4 | `v0.22.4 (2026.9.24) · local 4d04303818b6` | 0 | 0 | 0 | pass | 0 | pass |
| v0.22.3 | `v0.22.3 (2026.9.24) · local 5b147ab036d6` | 0 | 0 | 0 | pass | 0 | pass |
| v0.22.2 | `v0.22.2 (2026.9.24) · local d923a5eb487a` | 0 | 0 | 0 | pass | 0 | pass |
| v0.22.1 | `v0.22.1 (2026.9.24) · local 297552a9d646` | 0 | 0 | 0 | pass | 0 | pass |
| v0.22.0 | `v0.22.0 (2026.9.24) · local e06df9c2eae6` | 0 | 0 | 0 | pass | 0 | pass |
| v0.21.7, v0.21.6, earlier calendar tags | not run | - | - | - | - | - | untested |

Every row above is one fresh isolated home. The v0.23.1 row is the in-harness baseline; the same release also passed earlier on 2026-11-15 in `docs/validation/results/hermes.md`.

Discarded runs (not counted above):
- v0.23.0 (two attempts), v0.22.1 and v0.22.2 (first attempts): `enable` failed with `ENOSPC` (`No space left on device`) because the shared disk filled during the runs. Each was rerun in a clean home.
- The first pty attempt on v0.23.1 (before the driver answered setup prompts) stopped at the "Enable auto-prune?" prompt, so the command was never run. The driver was then fixed to answer that prompt and the telemetry prompt. Every row above uses the fixed driver.

Observations:
- `hermes plugins enable` prints `✓ Plugin ultrathink enabled.` on v0.23.x and `Takes effect on next session.` on v0.22.x.
- The install doc's removal claim (per-file install, `remove` exits 0) held on every tested release. The directory-link install failure (`Invalid plugin name ...`) was observed only on v0.23.1 (`docs/validation/results/hermes.md`) and was not re-tested on older releases.
- Isolated gateway processes started during `chat` and were stopped by the harness. No process from the real home was touched.

## Cleanup

All run directories were removed after the results were recorded: `/tmp/ut-minver-hermes` (checkouts, venvs, python, homes, logs). The worktree `/root/src/worktrees/ut-min-hermes` remains because it holds this file. Nothing was committed.

## 2026-11-15 gap run: v0.21.5, v0.21.6, v0.21.7

Scope: the four unvalidated gaps for hermes, limited to the three versions named in the assignment, in order, stopping at the first failure. Worktree `/root/src/worktrees/ut-gap-hermes` from `origin/docs/min-versions-ac3`. No commit.

Tags tested:

- `v0.21.7` and `v0.21.6`: git tags as named.
- `v0.21.5`: no git tag `v0.21.5` exists (`git ls-remote --tags` returns nothing for it). The GitHub release titled "Hermes Agent v0.21.5 (v2026.9.24)" is tag `v2026.9.24`, and that tag was tested.

Method: same as the sweep above (per-file symlinks from `hosts/hermes/` at this branch, `hermes plugins enable/list/remove`, pty invoke of `/ultrathink-lessons` expecting `No lessons saved yet.`, isolated `HOME`/`HERMES_HOME`, placeholder `custom` model at `127.0.0.1:9`, telemetry off, `env -i` with PATH, TERM, LANG, HOME, HERMES_HOME only). Each tag: `uv venv --python 3.14.8` and `uv pip install -e <checkout>`.

Caveat: `v2026.9.24` declares `requires-python = ">=3.11,<3.14"`. Its install on Python 3.14.8 exited 0 and the lifecycle passed, but 3.14.8 is outside the declared range and no run on 3.11 to 3.13 was made.

| Tag | `hermes --version` | install | enable | list (load) | pty invoke | remove | Verdict |
|---|---|---|---|---|---|---|---|
| v0.21.7 | `Hermes Agent v0.21.7 (2026.9.24) · stable · local 71d34bad1045` | 0 | 0 | 0 | pass | 0 | pass |
| v0.21.6 | `Hermes Agent v0.21.6 (2026.9.24) · upstream 818c13be` | 0 | 0 | 0 | pass | 0 | pass |
| v2026.9.24 (titled v0.21.5) | `Hermes Agent v0.21.5 (2026.9.24)` | 0 | 0 | 0 | pass | 0 | pass |

Discarded run (not counted as a release result): the first v0.21.7 pty run sent the command before the TUI accepted input (`pty=1`, `MARKER_MISSING`, the input box still showed its placeholder and no reply). The driver was changed to wait for `Welcome to Hermes Agent`, type the command, then send Enter. v0.21.7 was then rerun from a clean home and passed. The marker was checked only after the command was sent; the screen captured before sending in the discarded run did not contain it.

Observations:

- On v0.21.7, `hermes --version` printed `Could not resolve the stable source release: HTTP Error 403: rate limit exceeded` (the GitHub update check). Exit codes of the lifecycle steps were unaffected.
- `hermes plugins enable` printed `Takes effect on next session.` on all three tags.

Result: **none validated.** All three gap versions passed on Python 3.14.8, so this run recorded no failing release and no failure sits at the next lower release. v0.21.4 (`v2026.9.21`) is the next lower release. It was outside this assignment's scope and was not tested. The lowest passing tested release is now v0.21.5 (tag `v2026.9.24`), which is not a validated minimum. The floor in `adapters/version-floor.ts` and the install doc's "not documented" statement are unchanged by this run.

Cleanup: `/tmp/ut-gap-hermes` (checkouts, venvs, Python installs, isolated homes, logs) was removed after the results were recorded. The worktree `/root/src/worktrees/ut-gap-hermes` remains because it holds this file. Nothing was committed.

## 2026-11-15 Python 3.12 run: v0.23.1 (floor), stopped at first failure

Scope: the in-range re-run requested by the main agent, on Python 3.12 for every run: v0.23.1 first, then v0.22.0, v0.21.7, v0.21.4 (`v2026.9.21`), and v0.21.3 only if v0.21.4 passed. Stop at the first failure. The first step failed, so the chain stopped there.

Method: `git clone --depth 1 --branch v0.23.1` (commit `3b421578`); `uv venv --python 3.12` (CPython 3.12.3); `uv pip install -e <checkout>` (exit 0); per-file symlinks from `hosts/hermes/*.py` (minus `*_test.py`) and `plugin.yaml` at the worktree's `origin/main`; placeholder `custom` model at `127.0.0.1:9`, telemetry off; `env -i` with PATH, TERM, LANG, HOME, HERMES_HOME only. Lifecycle as in the sweep: `hermes plugins enable ultrathink`, `hermes plugins list --plain`, pty `/ultrathink-lessons` expecting `No lessons saved yet.`, `hermes plugins remove ultrathink`. The sweep's `lifecycle.sh` was no longer on disk, so the harness was rewritten; its setup-prompt answers were never exercised because the TUI never started.

| Tag | Python | install | version | enable | list | pty invoke | remove | Verdict |
|---|---|---|---|---|---|---|---|---|
| v0.23.1 (floor) | 3.12.3 | 0 | 0 | 1 | 1 | not reached (no setup prompt seen, command never sent) | 1 | not reached (dependency gate) |
| v0.22.0, v0.21.7, v2026.9.21, v0.21.3 | 3.12 | not run | - | - | - | - | - | not run (chain stopped) |

Cause: `pyproject.toml` declares `requires-python = ">=3.11,<3.15"`, but all 45 entries in `[project].dependencies` carry the marker `; python_version >= '3.14'`. On 3.12 the editable install therefore brings in no dependencies (the venv holds only `hermes-agent`). Every subcommand that imports `hermes_cli.main` then crashes with `ModuleNotFoundError: No module named 'ruamel'` (`hermes --version` still printed `Hermes Agent v0.23.1 (2026.9.24)`, exit 0). The plugin was never reached. This is a host install-metadata defect for Python 3.11 to 3.13, not a plugin result.

Diagnostic, not counted: I tried to install the 45 pins with markers stripped into the 3.12 venv, to see whether the plugin passes once dependencies are present. The pin set does not resolve on 3.12 (`uv pip install` and `uv pip compile` report unsatisfiable requirements, e.g. a git-URL `psutil` pin and `pillow` 12.3.0 against 13.0.0), so no lifecycle result with dependencies was obtained.

Verdict: v0.23.1 did not install a working host on Python 3.12 (dependency gate); lifecycle not reached. Python 3.12 is inside its declared range (`>=3.11,<3.15`). No minimum is validated by this run. The 3.14.8 results above are unchanged, and the floor in `adapters/version-floor.ts` is not changed by this run.

Cleanup: `/tmp/ut-v-hermes` (checkouts, venvs, homes, logs) was removed, and `pkill` found no leftover processes. The worktree `/root/src/worktrees/ut-v-hermes` holds this file. Nothing was committed.

