# Omp minimum version validation

Date (YYYY-MM-DD): 2026-11-15
Result: **Validated minimum 17.0.0** under this file's lifecycle criteria (2026-11-15 gap run, below). 16.0.0 fails step 5 (the plugin is installed by link and not listed) on 2 of 2 attempts. 15.0.0 was not tested because the run stopped at the first failure. Under a relaxed criterion the minimum is not established. The floor 18.19.0 (`adapters/version-floor.ts:18`) is not the lowest working version.

## Scope

- Host: Omp (`omp`). Floor: 18.19.0. Plugin under test: `ultrathink` from `origin/main` at `651e9fc`, worktree `/root/src/worktrees/ut-min-omp`, branch `docs/min-version-omp`. `omp plugin list` reports it as `ultrathink@1.4.0` (matches `package.json`).
- Source of releases: npm registry, `@oh-my-pi/pi-coding-agent` (715 published versions, including 0.1.0 through 18.20.2).
- Procedure: `docs/validation/results/minimum-host-versions.md` and `docs/install/omp.md`.

## Method

Each version was installed with `npm install --prefix /<iso>/<version> @oh-my-pi/pi-coding-agent@<version>` and run with an isolated environment:

```
env -i HOME=<iso>/home-<v> PI_CODING_AGENT_DIR=<iso>/home-<v>/.omp/agent PATH=<bun-1.4.4>/bin:/usr/bin:/bin LANG=C.UTF-8 TERM=dumb
```

Lifecycle, run from the worktree root:

1. `omp --version`
2. `omp plugin install --dry-run .`
3. `omp plugin list` (before)
4. `omp plugin install .`
5. `omp plugin list` (after install)
6. Invoke: `printf '{"type":"get_state"}\n{"type":"prompt","message":"/ultrathink-status"}\n' | omp --mode rpc` (`timeout 90`)
7. `omp plugin uninstall ultrathink --dry-run`
8. `omp plugin uninstall ultrathink`
9. `omp plugin list` (after uninstall)

Pass: every step exits 0; step 5 lists `ultrathink@`; step 6 returns two `"success":true` responses and the status notify contains `Prompt Uplift`; step 9 no longer lists ultrathink.

Notes on the method:

- **Bun runtime.** `omp` 18.19.0 refuses to start on Bun 1.4.0 with `error: Bun runtime must be >= 1.4.4 (found v1.4.0)`. That is the Bun on this machine's PATH. All runs used Bun 1.4.4, installed into an isolated prefix (`bun@1.4.4` from npm). The Omp install doc does not state this requirement; it is enforced by the host itself.
- **Credentials.** Without a login, step 6 exits 1 before any slash command runs: `No default model selected. Use /login, set an API key environment variable, or select a local model`. For the passing runs, the login files `agent.db` (with `-wal` and `-shm`), `config.yml` and `models.yml` were copied from the real `~/.omp/agent` into the isolated agent directory, mode 600. Values were never printed. The copies were deleted at the end of each run.
- **Real-home extension.** Omp loaded the real-home extension directory `/root/.omp/extensions/agent-swarm` in addition to the isolated home. It failed to load on 17.4.2, 18.0.0, 18.18.9 and 18.19.0 (`Failed to load extension /root/.omp/extensions/agent-swarm`), and did not appear in the 17.0.0 run. The ultrathink status notify appeared in every run, so this did not block the plugin.

## Results

| Version | 2 install --dry-run | 4 install . | 5 list (after) | 6 invoke (rpc) | 8 uninstall | Verdict |
|---|---|---|---|---|---|---|
| 18.19.0 | 0 | 0 | 0 (`ultrathink@1.4.0`) | 0 (2× `success:true`, `Prompt Uplift on`) | 0 | PASS |
| 18.18.9 | 0 | 0 | 0 | 0 (same) | 0 | PASS |
| 18.0.0 | 0 | 0 | 0 | 0 (same) | 0 | PASS |
| 17.4.2 | 0 | 0 | 0 | 0 (same) | 0 | PASS |
| 17.0.0 | 0 | 0 | 0 | 0 (same) | 0 | PASS |
| 9.0.0 | 1 | 1 | — | not reached | — | FAIL at install |

Details for each row:

- **18.19.0 (floor).** A first run without credentials passed steps 1–5, 7–8 and failed step 6 (exit 1, the model gate above). The credentialed rerun passed all steps. This matches the earlier interactive run recorded in `docs/validation/results/omp.md`.
- **9.0.0.** Both `plugin install --dry-run .` and `plugin install .` exit 1 with `✗ Failed to install .: Error: Invalid package name: .`. In this release the documented `.` path form is not accepted. Steps 6–9 were not evaluated because the install failed. The run was stopped during step 6 and the isolated processes were killed.

Versions not validated in this sweep:

- **16.0.0, 15.0.0:** the npm install was started and stopped when the sweep was wrapped up. No lifecycle run. **Untested.** 16.0.0 is the release directly below 17.0.0.
- **13.0.0:** `npm install` exit non-zero. Puppeteer's postinstall failed to download Chrome 148 (`Failed to set up chrome`). No lifecycle run.
- **11.0.0:** `npm install` exit non-zero. npm returned `E404` for `@oh-my-pi/pi-git-tool`, a dependency not present in the registry. No lifecycle run.
- **6.0.0:** `npm install` exit non-zero with `404` from npm. Cause not diagnosed. No lifecycle run.
- **All other releases** (1.x–8.x, 10.x, 12.x, 14.x, 17.1–17.3.8, 18.1–18.17.x): **untested.**

## Stopped sweep

The sweep was stopped on the orchestrator's wrap-up instruction. The versions above marked untested were not run. The disk was shared and nearly full during the sweep; some installs failed with `ENOSPC` and were retried.

## Validated minimum

None established.

- Lowest passing release tested: 17.0.0. Below the floor, so the floor 18.19.0 is conservative for this lifecycle.
- A minimum needs the next lower release to fail. 9.0.0 fails, but 10.x–16.0.0 are untested, so the boundary lies somewhere in 10.0.0–16.0.0 or at 17.0.0 itself. This document does not claim any of those.
- Runtime enforcement: the floor is not checked at runtime at `611e926` or at `651e9fc` (see `docs/validation/results/minimum-host-versions.md`).

## Cleanup

- The isolated directory `/tmp/ut-min-omp` (npm prefixes, isolated homes with copied login files, Bun 1.4.4, logs) was removed. At cleanup time it no longer existed, so its removal was confirmed by a missing path, not by a deletion step in this run. The cause was not identified.
- Leftover RPC processes from the 9.0.0 run were killed.
- The copied login values were never printed. No credential values appear in this file.
- Only this file was created in the worktree. Nothing was committed.

## 2026-11-15 gap run: 16.0.0 and 15.0.0

This section supersedes "Validated minimum" above for the lifecycle criteria in this file.

### Method

- Gap versions, in order, stopping at the first failure, 2 attempts max: 16.0.0, then 15.0.0. Procedure, nine steps, pass criteria and isolated environment as in the sweep above, with Bun 1.4.4 in an isolated prefix (`bun@1.4.4` from npm).
- Plugin source: `origin/main` at `651e9fc`. The worktree `/root/src/worktrees/ut-gap-omp` at `origin/docs/min-versions-ac3` differs from `651e9fc` only under `docs/`.
- Attempt 2 added a read-only `omp plugin list --json` capture (step 5b) to show the link state. It does not change the pass criteria.

### Results

| Version | Attempt | Exit codes (steps 1-9) | Step 5 lists `ultrathink@` | Step 6 invoke | Verdict |
|---|---|---|---|---|---|
| 16.0.0 | 1 | all 0 | No | 2× `success:true`, `Prompt Uplift` | FAIL at step 5 |
| 16.0.0 | 2 | all 0 (5b also 0) | No (5b: no ultrathink entry) | 2× `success:true`, `Prompt Uplift` | FAIL at step 5 |
| 15.0.0 | — | not run | — | — | Not tested (stopped at first failure) |

- At 16.0.0, `plugin install --dry-run .` prints `[dry-run] Would link .`, and `plugin install .` prints `✔ Linked ultrathink from .`. `omp plugin list` (text and `--json`) shows no ultrathink entry before or after install. The 17.0.0 row in the sweep above lists `ultrathink@` after install.
- The rest of the lifecycle passes at 16.0.0. The plugin is active at step 6 (the status notify contains `Prompt Uplift`), and step 8 prints `✔ Uninstalled ultrathink`. The failure is limited to the step 5 listing criterion.
- Attempt 2 reproduced attempt 1 in a fresh home, so the result is not flaky.
- The `omp-polyglot@polyglot` marketplace entry appeared in every list. It is unrelated.

### Validated minimum

- Under the criteria in this file: **17.0.0**. 17.0.0 passes (sweep row), and the next lower tested release, 16.0.0, fails step 5 on 2 of 2 attempts.
- The failure is narrow. If the step 5 listing criterion were dropped, 16.0.0 would pass the functional lifecycle (link install, invoke, uninstall). The minimum would then lie below 16.0.0, which needs 15.0.0 and possibly lower. 15.0.0 was not tested because the stop rule ended the run at the first failure, so the relaxed-criterion minimum is not established.
- The floor 18.19.0 (`adapters/version-floor.ts:18`) is not enforced at runtime (see the sweep above) and is conservative for this lifecycle.

### Cleanup

- Login files (`agent.db`, `agent.db-wal`, `agent.db-shm`, `config.yml`, `models.yml`, mode 600) were copied into each isolated home. Each home was deleted at the end of its run. No credential values were printed or written here.
- The isolated directory `/tmp/ut-gap-omp` (Bun prefix, npm prefix, logs) was removed after this section was written.
- The real `~/.omp` plugin registry (`installed_plugins.json`, `plugins/`) was not modified after the run began (mtime check). Other sessions were writing to `~/.omp` (agent DB, logs, token-opt) during the window; those changes are not attributed here.
- Only this file was edited in the worktree. Nothing was committed.
