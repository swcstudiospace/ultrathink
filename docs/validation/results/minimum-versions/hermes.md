# Hermes minimum version: validation record

Date: 2026-11-15
Floor under test: v0.23.1 (`adapters/version-floor.ts:16`)
Plugin under test: `hosts/hermes/` from origin/main `651e9fc`, installed as per-file symlinks (`docs/install/hermes.md`).
Checkout: worktree `/root/src/worktrees/ut-min-hermes`, branch `docs/min-version-hermes`. No commit.

## Result

**None validated.** The lifecycle passed on every tested release from v0.22.0 through v0.23.1. No lower release was tested, so no release was shown to fail, and the lowest passing tested release (v0.22.0) is not a validated minimum. The rule for a validated minimum (the next lower release fails) is not met. The fallback ("lowest tested release if no lower release is installable offline") does not apply: lower official releases are installable from GitHub. The sweep was stopped on the main agent's instruction at v0.22.0.

Untested lower releases: v0.21.7, v0.21.6 (`v0.21.x` tags), and the calendar-tagged releases below v0.22.0 (for example `v2026.9.21`, which its release page titles "Hermes Agent v0.21.4").

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
