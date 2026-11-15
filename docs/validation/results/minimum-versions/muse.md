# Muse Code minimum version

Date: 2026-11-15
Host: Muse Code (`muse`). Floor: 1.4.14 (`adapters/version-floor.ts:15`). Plugin: ultrathink 1.4.0 from the worktree `/root/src/worktrees/ut-min-muse` (branch `docs/min-version-muse`, from origin/main `651e9fc`).

## Result

- **Lowest tested release: 1.4.2-R4684.1 (2026-11-15 gap run).** Gated lifecycle passes (all steps exit 0). Ungated fails: steps 1–4, 6 and 7 exit 2 with `plugins are not available in this build`; step 5 exec exits 0. Ungated 1.4.18-R8587.1 passes. Validated minimum: none. The ungated boundary lies in (1.4.2, 1.4.18] and is not located. 1.4.14 and 1.4.15 returned no manifest for the probed build strings (see the gap section).
- **The 1.4.14 floor is not validated.** No 1.4.14 binary or manifest was reachable, so no lower bound is claimed.
- Why no validated minimum: the channel endpoints expose only the current release (`1.4.20-R8619.1`), and the manifest endpoint takes an exact `version-R<build>` string. Before the gap run, no release below 1.4.18 had been found. The gap run obtained 1.4.2-R4684.1; the probed strings for 1.4.3, 1.4.14 and 1.4.15 returned no manifest. Build numbers for 1.4.14 and 1.4.15 are not published in any source I could reach (the repo cites them only as earlier observations). See "Version discovery" and the gap section.

## Versions tested

| Version | Binary source | Integrity | Gate | Lifecycle |
|---|---|---|---|---|
| 1.4.18-R8587.1 (`muse --version` → `Muse Code 1.4.18 (1.4.18-R8587.1)`) | `lookaside.facebook.com` manifest and `muse-x86-linux` artifact | sha256 `57732db8…e65b538` matched manifest; size 485689688 matched | `MUSE_EXPERIMENTAL_PLUGINS=1` | Pass (all steps exit 0) |
| 1.4.18-R8587.1 | same | same | unset | Pass (all steps exit 0) |
| 1.4.2-R4684.1 (`muse --version` → `Muse Code 1.4.2 (1.4.2-R4684.1)`) | `lookaside.facebook.com` manifest and `x86_linux` artifact | sha256 `dfb3096c…a1af64` matched manifest; size 344369368 matched | `MUSE_EXPERIMENTAL_PLUGINS=1` | Pass (all steps exit 0) |
| 1.4.2-R4684.1 | same | same | unset | Fail at steps 1–4, 6, 7 (exit 2, `plugins are not available in this build`); step 5 exec exit 0 |

Not tested: 1.4.20-R8619.1 (current; not needed to bound the minimum from below).

## Lifecycle, 1.4.18-R8587.1 (gated run, fresh isolated HOME)

Environment for every call: `env -i PATH=<bun dir>:/usr/bin:/bin HOME=<iso>/home BUN=<bun>`, plus `MUSE_EXPERIMENTAL_PLUGINS=1` for the gated run. The raw binary was run directly, not through the launcher, so no auto-update ran.

| Step | Command (cwd = worktree unless noted) | Exit | Observed |
|---|---|---|---|
| 1 list before | `muse plugins list` | 0 | `no plugins` |
| 2 install | `muse plugins install . --scope user` | 0 | `installed ultrathink 1.4.0 enabled=true trust=user-local`; warning: hooks require review before activation |
| 3 approve | `muse plugins approve ultrathink` | 0 | approved 3 hook capabilities |
| 4a load | `muse plugins list` | 0 | `ultrathink 1.4.0 enabled=true active=true valid=true` |
| 4b inspect | `muse plugins inspect ultrathink` | 0 | skills=5 commands=6 hooks=3; all three hooks `trusted_enabled` |
| 5 invoke | `muse exec --provider echo "Plan a small change: add a README line."` (cwd = scratch workspace) | 0 | echo reply printed; session log has 2 `hook_run_terminal` records |
| 5 hook check | session log `hook_run_terminal` records | — | `UserPromptSubmit`, `completed`, exit 0, effects `[context]`, system message `Prompt Uplift · UPLIFTED_PROMPT · fallback …`; `Stop`, `completed`, exit 0 |
| 6 remove | `muse plugins remove ultrathink --delete-data` | 0 | `removed ultrathink` |
| 7 list after | `muse plugins list` | 0 | `no plugins` |

The invoke runs without Meta credentials, so the hook used its fallback spec, as the install doc describes. The planning engine was not exercised.

## Ungated run, 1.4.18-R8587.1 (fresh isolated HOME, same commands, `MUSE_EXPERIMENTAL_PLUGINS` unset)

Steps 1–7 all exit 0. The hook records match the gated run: `UserPromptSubmit` completed exit 0 and `Stop` completed exit 0.

This differs from the 2026-11-13 matrix run on 1.4.18, which saw non-gated install fail 3 of 3 times with `held project plugin source inventory changed during snapshot`. This run had no concurrent writers in the worktree, and that failure did not recur. The cause of the earlier failure is not isolated. The launcher still defaults the gate on.

## Diagnostics seen (non-fatal)

- `multiple-manifests`: selected `.muse-plugin/plugin.json`, ignored `.claude-plugin/plugin.json`.
- Sandbox: no capability-valid bubblewrap; the install was under `/tmp`, which the sandbox check flagged. Exec continued.
- `workspace is untrusted`: agent delegation unavailable. Not part of the lifecycle.

## Version discovery

- `https://api.meta.ai/muse-code/channels/muse-stable` and `…/muse-canary`: both return only `1.4.20-R8619.1`.
- Listing paths (`/channels`, `/releases`, `/versions`, `/channels/muse-stable/history`): HTTP 404.
- `https://lookaside.facebook.com/lookaside/muse/download/?channel=muse&version=<V>&file=manifest.json`: HTTP 200 only for an exact `<V>` with its build suffix. Known hits: `1.4.2-R4684.1`, `1.4.18-R8587.1`, `1.4.20-R8619.1`. A bare `1.4.14` returned 404.
- Build-number probes for 1.4.14 through 1.4.17 with build numbers R8440–R8600 (suffix `.1`), and R8500–R8586 (suffixes none, `.1`, `.2`), returned no manifest. These guesses are not a listing, and their absence proves nothing beyond "not found in those ranges".
- npm has no Muse Code CLI package (`@muse-code/sdk` is a client SDK). No Homebrew or pip source was checked.

## Cleanup

- Deleted `/tmp/muse-min` (both homes, the 1.4.18 binary, workspace, logs) and `/tmp/muse-scan`. Verified both absent.
- The isolated homes were created fresh. No credential file was copied, and no `auth.json` was read.
- Not used for the lifecycle. Before the isolated runs, I ran the real launcher `~/.local/bin/muse` for read-only probes: `--version`, `--help`, `update --help`, and `muse-launcher --help`. The launcher can refresh its update-check state (`.muse-update-checked-at`, `.muse-release-info.json`) in `~/.local/bin`. I read `~/.config/muse` only by file name (`ls`), not its contents. No plugin command ran against the real home, and no credentials were read or copied.
- Worktree `/root/src/worktrees/ut-min-muse`: this file is the only addition. Not committed.

## 2026-11-15 gap run: releases below 1.4.18

Scope: the gap for releases below 1.4.18 only. The real launcher `~/.local/bin/muse` was not run. Manifests came from the official `lookaside.facebook.com` manifest endpoint.

### Builds tried

| Build | Result | Evidence |
|---|---|---|
| 1.4.2-R4684.1 | Obtained. Gated lifecycle pass; ungated lifecycle fail | Manifest HTTP 200. `x86_linux` artifact size 344369368 and sha256 `dfb3096c…a1af64` matched the manifest. `muse --version` → `Muse Code 1.4.2 (1.4.2-R4684.1)` |
| 1.4.14 (probed strings) | Not obtainable | Bare `version=1.4.14` → 404. `1.4.14-R8587.1` → 404. Build-number guesses in "Version discovery" above → no manifest |
| 1.4.15 (probed strings) | Not obtainable | Bare `version=1.4.15` → 404 |
| 1.4.2 variants and 1.4.3 | Not obtainable | `1.4.2`, `1.4.2-R4684`, `1.4.2-R4684.2`, `1.4.3` → 404 |

The build string `1.4.2-R4684.1` comes from `~/.local/bin/.muse-update-notice`, which records a version transition from that build. The file was read as text, not executed. A search of `/` for `muse-bin-*` and `muse-x86-linux` found only `~/.local/bin/muse-bin-1.4.20-R8619.1` (current; not run; not below 1.4.18). Obtainable builds below 1.4.18: one of three allowed attempts used.

### Lifecycle, 1.4.2-R4684.1

- Gated (`MUSE_EXPERIMENTAL_PLUGINS=1`, fresh isolated HOME, raw binary, cwd = worktree): steps 1–7 all exit 0. Install: `installed ultrathink 1.4.0 enabled=true trust=user-local`. Inspect: `skills=5 commands=6 hooks=3`, all three hooks `trusted_enabled`. Exec with the echo provider: exit 0. Session log: `UserPromptSubmit` completed exit 0 and `Stop` completed exit 0.
- Ungated (flag unset, fresh isolated HOME): steps 1–4, 6, and 7 exit 2 with `plugins are not available in this build`. Step 5 (`muse exec`) exits 0. The plugin commands are dark in ungated mode, which matches the launcher comment that 1.4.2 puts the plugin host behind `MUSE_EXPERIMENTAL_PLUGINS`. No hook records were produced.

### Result

- Gated path: 1.4.2-R4684.1 passes. No release below 1.4.2 was probed, so no failing lower release is known. Validated minimum: none. The 1.4.14 floor is above 1.4.2, which passed on the gated path; this run does not show the floor to be a boundary.
- Ungated path (default on): 1.4.2-R4684.1 fails and 1.4.18-R8587.1 passes. The boundary lies in (1.4.2, 1.4.18]. The tested-pair rule applied literally would name 1.4.18, but 1.4.3 through 1.4.17 were not run. 1.4.14 and 1.4.15 returned no manifest for the probed strings, and bare 1.4.3 returned 404. The true boundary is not located. Validated minimum: none. Reason: the builds needed to bracket it were not obtained from the official manifest endpoint.

### Cleanup

- Deleted `/tmp/muse-gap` (both isolated homes, the 1.4.2 binary, workspaces, and logs) and the `/tmp/muse-probe-*.json` probe files. Verified absent.
- No credential file was read or copied. Only file names and the update-notice content were read.
- The worktree `/root/src/worktrees/ut-gap-muse` has only this file changed. Not committed.
