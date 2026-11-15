# Muse Code minimum version

Date: 2026-11-15
Host: Muse Code (`muse`). Floor: 1.4.14 (`adapters/version-floor.ts:15`). Plugin: ultrathink 1.4.0 from the worktree `/root/src/worktrees/ut-min-muse` (branch `docs/min-version-muse`, from origin/main `651e9fc`).

## Result

- **Validated minimum: 1.4.18 (lowest tested release; no lower release was installable).** This is not a proven minimum. The lifecycle passed on 1.4.18, and no release below it could be obtained.
- **The 1.4.14 floor is not validated.** No 1.4.14 binary or manifest was reachable, so no lower bound is claimed.
- Why no lower release: the official channel exposes only the current release, and the release manifest endpoint takes an exact `version-R<build>` string. Build numbers for 1.4.14 and 1.4.15 are not published in any source I could reach (the repo cites them only as earlier observations). See "Version discovery".

## Versions tested

| Version | Binary source | Integrity | Gate | Lifecycle |
|---|---|---|---|---|
| 1.4.18-R8587.1 (`muse --version` → `Muse Code 1.4.18 (1.4.18-R8587.1)`) | `lookaside.facebook.com` manifest and `muse-x86-linux` artifact | sha256 `57732db8…e65b538` matched manifest; size 485689688 matched | `MUSE_EXPERIMENTAL_PLUGINS=1` | Pass (all steps exit 0) |
| 1.4.18-R8587.1 | same | same | unset | Pass (all steps exit 0) |

Not tested: 1.4.20-R8619.1 (current; not needed to bound the minimum from below).

## Lifecycle (gated run, fresh isolated HOME)

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

## Ungated run (fresh isolated HOME, same commands, `MUSE_EXPERIMENTAL_PLUGINS` unset)

Steps 1–7 all exit 0. The hook records match the gated run: `UserPromptSubmit` completed exit 0 and `Stop` completed exit 0.

This differs from the 2026-11-13 matrix run on 1.4.18, which saw non-gated install fail 3 of 3 times with `held project plugin source inventory changed during snapshot`. This run had no concurrent writers in the worktree, and that failure did not recur. The cause of the earlier failure is not isolated. The launcher still defaults the gate on.

## Diagnostics seen (non-fatal)

- `multiple-manifests`: selected `.muse-plugin/plugin.json`, ignored `.claude-plugin/plugin.json`.
- Sandbox: no capability-valid bubblewrap; the install was under `/tmp`, which the sandbox check flagged. Exec continued.
- `workspace is untrusted`: agent delegation unavailable. Not part of the lifecycle.

## Version discovery

- `https://api.meta.ai/muse-code/channels/muse-stable` and `…/muse-canary`: both return only `1.4.20-R8619.1`.
- Listing paths (`/channels`, `/releases`, `/versions`, `/channels/muse-stable/history`): HTTP 404.
- `https://lookaside.facebook.com/lookaside/muse/download/?channel=muse&version=<V>&file=manifest.json`: HTTP 200 only for an exact `<V>` with its build suffix. Known hits: `1.4.18-R8587.1`, `1.4.20-R8619.1`. A bare `1.4.14` returned 404.
- Build-number probes for 1.4.14 through 1.4.17 with build numbers R8440–R8600 (suffix `.1`), and R8500–R8586 (suffixes none, `.1`, `.2`), returned no manifest. These guesses are not a listing, and their absence proves nothing beyond "not found in those ranges".
- npm has no Muse Code CLI package (`@muse-code/sdk` is a client SDK). No Homebrew or pip source was checked.

## Cleanup

- Deleted `/tmp/muse-min` (both homes, the 1.4.18 binary, workspace, logs) and `/tmp/muse-scan`. Verified both absent.
- The isolated homes were created fresh. No credential file was copied, and no `auth.json` was read.
- Not used for the lifecycle. Before the isolated runs, I ran the real launcher `~/.local/bin/muse` for read-only probes: `--version`, `--help`, `update --help`, and `muse-launcher --help`. The launcher can refresh its update-check state (`.muse-update-checked-at`, `.muse-release-info.json`) in `~/.local/bin`. I read `~/.config/muse` only by file name (`ls`), not its contents. No plugin command ran against the real home, and no credentials were read or copied.
- Worktree `/root/src/worktrees/ut-min-muse`: this file is the only addition. Not committed.
