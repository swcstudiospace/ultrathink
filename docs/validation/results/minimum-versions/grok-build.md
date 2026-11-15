# Grok Build minimum version: validation run

Date: 2026-11-15
Host: Grok Build (`grok`, npm `@xai-official/grok`)
Floor: 1.0.77 (`adapters/version-floor.ts:14`). npm `latest` dist-tag at run time: 1.0.77.
Checkout under test: `origin/main` at `651e9fc` (worktree `/root/src/worktrees/ut-min-grok-build`, branch `docs/min-version-grok-build`, uncommitted).
Tester: MinVersionGrokBuild (worker agent).

## Result

- **Plugin lifecycle passes from 1.0.42 among the stable 1.0.x releases tested.** The next lower release, 1.0.41, fails (2 of 2 runs), and every stable 1.0.x release below 1.0.42 was tested and fails the hook.
- **Host-level invoke works from 1.0.13.** Below 1.0.13 the server returns HTTP 426. The plugin hook is still absent at 1.0.13 through 1.0.40, so 1.0.13 does not meet the plugin criterion.
- **Scope limit:** the 0.x line was not fully validated (15 releases untested, see "0.x line"), so 1.0.42 is the lowest validated plugin-lifecycle release on the 1.0.x line, not a proven global minimum.
- **Credential risk (unverified):** every invoke ran with a copy of the live `/root/.grok/auth.json`. These runs may have invalidated the real login: refresh-token rotation could have revoked the token the real file holds. Rotation was not verified, and the real home's token state was not checked after the runs. No run result shows the real login is intact. The unchanged file mtime is not evidence about token state.

## Criteria

- Install: `grok plugin install /root/src/worktrees/ut-min-grok-build --trust`, exit 0, then `grok plugin list` and `grok plugin details ultrathink`, exit 0.
- Load: `plugin details` inventory only. Interactive load was not run.
- Invoke: `grok -p "Say OK in one word." --always-approve`, run from an isolated work dir with `HOME` and `GROK_HOME` set to the run's isolated home, and `env -u ANTHROPIC_API_KEY -u XAI_API_KEY`. The invoke passes only if exit 0, stdout is `OK`, and `sessions/*/updates.jsonl` shows `hook_execution` with `event_name: user_prompt_submit` and `status: success`. Host-only invokes without the hook event are recorded as "no hook".
- Login: `/root/.grok/auth.json` was copied (`cp -p`) into each isolated `GROK_HOME` for the invoke step and removed right after. Contents were never printed. The real file's mtime was unchanged (`2026-11-14 23:49:12 UTC`), which is not evidence about token state. Refresh-token rotation was not verified. An isolated invoke may have rotated the token server-side, so the real `/root/.grok/auth.json` may hold a token the server no longer accepts. The real home's token state after the runs was not checked, and no run result shows the real login is intact. This is an unverified risk, not an observed effect. No conclusion in this record depends on the real login being unchanged.
- Exit codes: `npm` = `npm install --prefix`; `inst` = `grok plugin install`; `inv` = `grok -p` invoke.

## Tested versions (stable npm releases)

| Version | npm | inst | inv | Observed | Result |
|---|---|---|---|---|---|
| 1.0.0 | 0 | 0 | 1 | HTTP 426 "outdated … 1.0.13 or later" | Fail |
| 1.0.1–1.0.11 (11 versions) | 0 | 0 | 1 | HTTP 426 each | Fail |
| 1.0.12 | 0 | 0 | 1 | HTTP 426 "1.0.13 or later" | Fail |
| 1.0.13–1.0.40 (28 versions, incl. 1.0.13, 1.0.18, 1.0.23, 1.0.29, 1.0.36, 1.0.37, 1.0.39) | 0 | 0 | 0 | `OK`, no hook execution | Fail (no plugin hook) |
| 1.0.41 (run 1) | 0 | 0 | 0 | `OK`, no hook execution | Fail (no plugin hook) |
| 1.0.41 (rerun) | 0 | 0 | 0 | `OK`, no hook execution | Fail (no plugin hook) |
| 1.0.42 (run 1) | 0 | 0 | 0 | `OK`, user_prompt_submit hook `success` (186 s), stop hook `success` | Pass |
| 1.0.42 (rerun) | 0 | 0 | 0 | `OK`, user_prompt_submit hook `success` | Pass |
| 1.0.43 | 0 | 0 | 0 | `OK`, user_prompt_submit hook `success` | Pass |
| 1.0.45 | 0 | 0 | 0 | `OK`, user_prompt_submit hook `success` | Pass |
| 1.0.77 (floor) | 0 | 0 | 0 | `OK`, user_prompt_submit hook `success` | Pass |

Version strings reported by `grok --version` matched each installed release (for example `grok 1.0.41 (4220f3b224a6)`, `grok 1.0.42 (4651fbdf9f13)`, `grok 1.0.77 (50ca579fa996)`).

The 1.0.77 run here matches the floor observation already recorded in `docs/validation/results/grok-build.md`. Invoke stdout was `OK`, exit 0.

## 0.x line

- `0.1.0` is listed in npm `time` but returns E404 on install. The lowest installable release is `0.1.202`.
- `0.1.202`: install 0, plugin install exit 2 (the old binary does not accept `plugin install`), invoke exit 1 with HTTP 426.
- `0.2.121`: install 0, plugin install 0, invoke exit 1 with HTTP 426.
- A sweep of the other 136 stable releases below 1.0.0 ran with 3 installs in parallel. The disk filled during the sweep (`ENOSPC`), so 15 runs are infrastructure failures and are **untested**: 0.1.203, 0.1.204, 0.1.205, 0.1.209, 0.2.1, 0.2.2, 0.2.3, 0.2.4, 0.2.11, 0.2.13, 0.2.25, 0.2.26, 0.2.27, 0.2.28, 0.2.29.
- 0.1.206 through 0.2.x (other than the cases above): plugin install exit 2 (unsupported subcommand), invoke HTTP 426.
- Count reconciliation: the sweep covers 136 releases; 15 are untested (listed above), so 121 sweep runs completed. Adding the separately run 0.1.202 and 0.2.121 gives 123 completed 0.x runs. The text reports 113 of them as installed and reaching invoke with HTTP 426. The file does not record how the other 10 (123 - 113) were classified, so that gap is not accounted for. Per-run plugin install exit codes are recorded only as a range (0.1.206 through 0.2.x: exit 2); the one 0.x run recorded with plugin install 0 is 0.2.121. The file records no 0.x run passing.
- Stable 1.0.x releases are complete. The 0.x line is incomplete: the 15 untested versions above, plus 0.1.0 (not installable) and any 0.x release not in the sweep list.

## Caveats

- The "no hook" evidence rests on `hook_execution` records in `sessions/*/updates.jsonl`. Those records are absent in every run from 1.0.13 through 1.0.41. Hook presence is the only criterion that separates 1.0.41 from 1.0.42.
- Load was not exercised interactively, so the validated lifecycle does not include a live load step.
- Trust was granted by `--trust` only; the trust state is not observable from the host.
- Whether the isolated invoke rotated the refresh token server-side was not verified.
- Non-monotonic releases: the 1.0.x line was tested exhaustively from 1.0.0 to 1.0.41, so a lower passing release cannot exist within 1.0.x. The 0.x line is not exhaustively tested.

## Cleanup

- Isolated install prefixes, homes, and copied login files were under `/tmp/ut-min-grok-build` and were removed after this record was written.
- Each run removed its copied `auth.json` immediately after invoke.
- No credential value was printed, written, or committed.
- Real `~/.grok` mtimes were unchanged after the runs: `auth.json` and `bin`. Refresh-token state was not checked, so this does not show the real login was unaffected (see Login).
