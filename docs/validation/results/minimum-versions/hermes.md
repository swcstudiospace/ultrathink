# Hermes minimum version: validation record

Date: 2026-11-15
Floor under test: v0.23.1 (`adapters/version-floor.ts:16`)
Plugin under test: `hosts/hermes/` from origin/main `651e9fc`, installed as per-file symlinks (`docs/install/hermes.md`).
Checkout: worktree `/root/src/worktrees/ut-min-hermes`, branch `docs/min-version-hermes`. No commit.

## Result

**None validated.** The lifecycle passed on every tested release from v0.21.5 through v0.23.1 (v0.21.5, v0.21.6 and v0.21.7 added 2026-11-15; see the dated section below). No tested release has failed, so the rule for a validated minimum (the next lower release fails) is not met, and the lowest passing tested release (v0.21.5, tag `v2026.9.24`) is not a validated minimum. The fallback ("lowest tested release if no lower release is installable offline") does not apply: lower official releases are installable from GitHub. The original sweep was stopped on the main agent's instruction at v0.22.0.

Untested lower releases: v0.21.4 (`v2026.9.21`, which its release page titles "Hermes Agent v0.21.4") and earlier calendar tags. No `v0.21.5` git tag exists; the release titled "Hermes Agent v0.21.5" is tag `v2026.9.24`.

## Sources and method

- Releases: official tags of `github.com/NousResearch/hermes-agent`, cloned with `git clone --depth 1 --branch <tag>`. The npm `hermes-agent` and PyPI `hermes-agent` packages are third-party bridges and were not used.
- Install per tag: `uv venv --python 3.14.8` (Python fetched into the prefix), then `uv pip install -e <checkout>`. The non-editable install refuses to build, so the editable install was used. The operator's install uses Python 3.14.9; this run used 3.14.8.
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

Result: **none validated.** All three gap versions passed, so no tested release has failed and no failure sits at the next lower release. v0.21.4 (`v2026.9.21`) is the next lower release. It was outside this assignment's scope and was not tested. The lowest passing tested release is now v0.21.5 (tag `v2026.9.24`), which is not a validated minimum. The floor in `adapters/version-floor.ts` and the install doc's "not documented" statement are unchanged by this run.

Cleanup: `/tmp/ut-gap-hermes` (checkouts, venvs, Python installs, isolated homes, logs) was removed after the results were recorded. The worktree `/root/src/worktrees/ut-gap-hermes` remains because it holds this file. Nothing was committed.
