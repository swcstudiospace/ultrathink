# Omp minimum version validation

> **Isolation caveat.** The sweep and the 2026-11-15 gap run, which precede the "Clean-home boundary rerun" section, were not isolated. The copied login config and agent DB named the real-home extension `/root/.omp/extensions/agent-swarm`, and Omp attempted to load it. Those runs are not evidence for the boundary, and the "Validated minimum" sections before the clean-home section are superseded by the Result above. The clean-home section is the stated basis. Its 17.0.0 PASS is attempt 2 only; attempt 1 is excluded as invalid.

Date (YYYY-MM-DD): 2026-11-15
Result: **Lowest passing release tested under the step 5 listing criterion: 17.0.0.** 16.0.0 passes every lifecycle step (link install, invoke, uninstall) and fails only the step 5 `plugin list` listing check, on 2 of 2 clean-home attempts. Basis: the "2026-11-15 clean-home boundary rerun" section at the end of this file. Releases below 16.0.0 were not tested under a clean home, so no lower boundary is established, and 17.0.0 is not shown to be a minimum under a relaxed criterion. The floor 18.19.0 (`adapters/version-floor.ts:18`) is not the lowest working version.

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
- **Real-home extension.** Omp loads the real-home extension directory `/root/.omp/extensions/agent-swarm` in addition to the isolated home when the run's copied config or cache names it. In the sweep, the load failed on 17.4.2, 18.0.0, 18.18.9 and 18.19.0 (`Failed to load extension /root/.omp/extensions/agent-swarm`). The sweep's 17.0.0 run showed no such line, but that run was not isolated (see the caveat above), so it does not show the extension was absent. The clean-home 17.0.0 attempt 1 did attempt the load (`Cannot find module`); that attempt is INVALID and excluded from every result in this file. The clean-home 17.0.0 attempt 2 and both clean-home 16.0.0 attempts show no real-home extension load. The ultrathink status notify appeared on every valid run with credentials that completed step 6, so the agent-swarm load failures did not block the plugin.

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

- The isolated directory `/tmp/ut-min-omp` (npm prefixes, isolated homes with copied login files, Bun 1.4.4, logs) was already missing at cleanup time, and no deletion step in this run removed it. Its removal is not verified: the only check was that the path was absent, which does not show that this run removed it. The cause of its disappearance is unidentified.
- Leftover RPC processes from the 9.0.0 run were killed.
- The copied login values were never printed. No credential values appear in this file.
- Only this file was created in the worktree. Nothing was committed.

## 2026-11-15 gap run: 16.0.0 and 15.0.0

This gap run is not evidence for the boundary (see the caveat at the top). Its 16.0.0 result is superseded by the clean-home rerun below and is not used. The record below is kept as a log of what was run.

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

- At 16.0.0, `plugin install --dry-run .` prints `[dry-run] Would link .`, and `plugin install .` prints `✔ Linked ultrathink from .`. `omp plugin list` (text and `--json`) shows no ultrathink entry before or after install.
- The rest of the lifecycle passes at 16.0.0. The plugin is active at step 6 (the status notify contains `Prompt Uplift`), and step 8 prints `✔ Uninstalled ultrathink`. The failure is limited to the step 5 listing criterion.
- The clean-home rerun's two 16.0.0 attempts give the same result.
- The `omp-polyglot@polyglot` marketplace entry appeared in every list. It is unrelated.

### Lowest passing release under the listing criterion

- Under the listing criterion, per the clean-home rerun: **17.0.0** is the lowest passing release tested (attempt 2 is the pass). 16.0.0 fails step 5 on 2 of 2 clean-home attempts.
- The failure is narrow. If the step 5 listing criterion were dropped, 16.0.0 would pass the functional lifecycle (link install, invoke, uninstall), per the clean-home attempts. The minimum would then lie below 16.0.0, which needs 15.0.0 and possibly lower. 15.0.0 was not tested under a clean home, so the relaxed-criterion minimum is not established.
- The floor 18.19.0 (`adapters/version-floor.ts:18`) is not enforced at runtime (see `docs/validation/results/minimum-host-versions.md`) and is conservative for this lifecycle.

### Cleanup

- Login files (`agent.db`, `agent.db-wal`, `agent.db-shm`, `config.yml`, `models.yml`, mode 600) were copied into each isolated home. Each home was deleted at the end of its run. No credential values were printed or written here.
- The isolated directory `/tmp/ut-gap-omp` (Bun prefix, npm prefix, logs) is not verified as removed: this file records no deletion step or missing-path check for it.
- The real `~/.omp` plugin registry (`installed_plugins.json`, `plugins/`) was not modified after the run began (mtime check). Other sessions were writing to `~/.omp` (agent DB, logs, token-opt) during the window; those changes are not attributed here.
- Only this file was edited in the worktree. Nothing was committed.

## 2026-11-15 clean-home boundary rerun: 17.0.0 and 16.0.0

Scope: 17.0.0 and 16.0.0 only, rerun with every Omp home, config and extension directory inside a fresh temp tree. Plugin: `origin/main` at `651e9fc`, checked out in worktree `/root/src/worktrees/ut-omp-clean` (`origin/docs/min-versions-ac3`, which differs only under `docs/`). This section is the basis for the Result at the top of this file.

### Method (clean-home)

- Installs: `bun@1.4.4` and `@oh-my-pi/pi-coding-agent@<v>` each in its own npm prefix under a fresh temp tree. The npm cache and Puppeteer cache were also kept inside that tree.
- Environment per run: `env -i HOME=<tree>/runs/<v>/home PI_CODING_AGENT_DIR=<home>/.omp/agent XDG_CONFIG_HOME, XDG_DATA_HOME, XDG_CACHE_HOME, XDG_STATE_HOME` all under `<home>`, `PATH=<bun-1.4.4>/bin:<omp-prefix>/bin:/usr/bin:/bin LANG=C.UTF-8 TERM=dumb`.
- Deviation from the sweep: the plugin is passed as the absolute worktree path instead of `.`, and the process cwd is an empty directory inside the temp tree, not the worktree. Reason: the project-config lookup (`findAllNearestProjectConfigDirs`, `src/config.ts:213-235` in `@oh-my-pi/pi-coding-agent` 17.0.0) walks from cwd to `/` without stopping at the isolated home. From the worktree path, which sits under `/root`, it finds `/root/.omp/extensions` as a project extension directory. That is the real-home directory the isolation rule forbids.
- Lifecycle, same nine steps as the sweep, with step 5b added (`omp plugin list --json`, read-only): 1 `--version`; 2 `plugin install --dry-run <wt>`; 3 `plugin list`; 4 `plugin install <wt>`; 5 `plugin list`; 5b `plugin list --json`; 6 `timeout 90 omp --mode rpc` with `get_state` and `/ultrathink-status`; 7 `plugin uninstall ultrathink --dry-run`; 8 `plugin uninstall ultrathink`; 9 `plugin list`. Pass criteria as in the sweep.
- Login files: `agent.db` (with `-wal` and `-shm`), `config.yml` and `models.yml` were copied into each isolated agent directory, mode 600, because step 6 needs a default model. Values were never printed or written to this file.
- Isolated copies were sanitized before each run; the real home was not modified. (a) The copied `config.yml` had an `extensions:` setting listing `/root/.omp/extensions/agent-swarm`; that key and item were removed. (b) The copied `agent.db` `cache` table held 21 `extension_startup:v1|v2:/root/.omp/...` rows, including `agent-swarm`; those rows were deleted, followed by a WAL checkpoint and VACUUM. After sanitizing, real-home references were 0 in both files.

### Extension-loaded check

- Before each run: no `.omp` directory among the ancestors of the run cwd, and the isolated `extensions` directory was empty.
- After each run: a grep for `/root/.omp` across the run's stdout, stderr, step logs and the isolated Omp log directory returned 0 hits for the valid runs. `agent.db` returned 0 references. Stderr was 0 bytes. No `Failed to load extension` line appeared.
- The step 6 `get_state` output lists extension-sourced commands (ultrathink and others) but contains no real-home path.
- The real-home plugin registry (`~/.omp/plugins/installed_plugins.json`) had the same mtime before and after every run.

### Results

| Version | Attempt | Isolation | Exit codes steps 1-9 | Step 5 lists `ultrathink@` | Step 6 (rpc) | Real-home extension loaded | Verdict |
|---|---|---|---|---|---|---|---|
| 17.0.0 | 1 | Not clean: copied `config.yml` and `agent.db` cache named `/root/.omp/extensions/agent-swarm` | all 0 | yes | 2× `success:true`, `Prompt Uplift` | No: load attempted and failed (`Cannot find module`) | INVALID, not counted |
| 17.0.0 | 2 | Clean (sanitized copies) | all 0 | yes | 2× `success:true`, `Prompt Uplift` | No | PASS |
| 16.0.0 | 1 | Clean (sanitized copies) | all 0 | no | 2× `success:true`, `Prompt Uplift` | No | FAIL at step 5 |
| 16.0.0 | 2 | Clean (sanitized copies) | all 0 | no | 2× `success:true`, `Prompt Uplift` | No | FAIL at step 5 |

- 17.0.0 attempt 2: step 2 `[dry-run] Would link <wt>`; step 4 `✔ Linked ultrathink from <wt>`; step 5b includes an ultrathink entry; step 7 and step 8 `✔ Uninstalled ultrathink`; step 9 no longer lists ultrathink.
- 16.0.0 (both attempts): step 2 and step 4 print the same link messages; step 5 and step 5b list no ultrathink entry; steps 7-9 pass; the plugin is active at step 6.
- 17.0.0 attempt 1 is recorded as invalid. Its lifecycle exit codes were all 0. Its isolation was breached: the copied config named the real-home `agent-swarm` extension, and the run attempted to load it (`Failed to load extension /root/.omp/extensions/agent-swarm`, `Cannot find module`). The load failed, so the extension did not run, but the run is excluded under the isolation rule. The 17.0.0 result above comes from attempt 2 only.

### Boundary result

- Under clean homes, 17.0.0 passes and 16.0.0 fails step 5 on 2 of 2 attempts, with all other steps passing. This matches the real-home gap run above, so the boundary is unchanged: the lowest tested release passing this file's lifecycle criteria is 17.0.0, and 16.0.0 fails only the step 5 listing check.
- 15.0.0 was not run in this rerun, which covered 17.0.0 and 16.0.0 only.

### Cleanup

- Login copies (`agent.db`, `agent.db-wal`, `agent.db-shm`, `config.yml`, `models.yml`) were deleted from every isolated agent directory, along with the inspection copy of `agent.db` used to locate the real-home cache rows.
- The isolated tree `/tmp/ut-clean-omp.4hw4LX` (Bun and npm prefixes, npm and Puppeteer caches, homes, logs) was removed. Deletion was confirmed by a missing-path check.
- The real-home `~/.omp` was not modified. Only this file was edited in the worktree. Nothing was committed.
