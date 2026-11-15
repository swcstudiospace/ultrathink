# Omp minimum version validation

Date (YYYY-MM-DD): 2026-11-15
Result: **None validated.** The lowest tested release that passes the lifecycle is 17.0.0. The minimum is not established: the next lower release, 16.0.0, was not tested (see Stopped sweep). The floor 18.19.0 (`adapters/version-floor.ts:18`) is not the lowest working version.

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
