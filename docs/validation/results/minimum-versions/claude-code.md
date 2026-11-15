# Claude Code: minimum supported version (validation record)

Date: 2026-11-15
Host: Claude Code. Floor under test: 2.1.322 (`adapters/version-floor.ts:13`).
Plugin under test: checkout at `origin/main`, worktree `/root/src/worktrees/ut-min-claude-code` (manifest version 1.4.0). Installed from that local path, not from GitHub.
Tester: MinVersionClaudeCode.

## Result

**None validated.** The lifecycle passes at 2.1.179, 2.1.186, 2.1.200, 2.1.250, 2.1.280, 2.1.300 and 2.1.321. It fails at 2.1.177, 2.1.176, 2.1.174, 2.1.150 and 2.1.100. The boundary lies between 2.1.177 (FAIL) and 2.1.179 (PASS). Its only intermediate release, 2.1.178, is **untested**: that run was stopped at wrap-up. The procedure needs the next lower release to be shown to fail, so no minimum is claimed.

- Lowest tested passing release: **2.1.179**. Not a validated minimum, because 2.1.178 is untested.
- The floor (2.1.322) is above the lowest tested pass, 2.1.179. This lifecycle does not justify the floor.
- Tested releases below 2.1.100 did not pass: 2.0.0 and 1.0.33 failed; 1.0.0 hung with no verdict; the first 2.1.51 run was invalid (nested-session guard) and was not rerun. Releases between 2.1.100 and 2.1.150 were not tested.

## Lifecycle (exact commands)

`ISO` is a per-version directory. `HOME=$ISO/home`, `CLAUDE_CONFIG_DIR=$ISO/home/.claude`. `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and `CLAUDECODE` are unset.

1. Install: `npm install --prefix "$ISO/npm" --no-audit --no-fund @anthropic-ai/claude-code@<V>`, then `"$CLI" --version` must print `<V> (Claude Code)`. `CLI=$ISO/npm/node_modules/.bin/claude`. Retried up to 6 times when npm exited non-zero or the native binary was missing (see disk note).
2. Marketplace: `"$CLI" plugin marketplace add /root/src/worktrees/ut-min-claude-code`
3. Install: `"$CLI" plugin install ultrathink@ultrathink --scope user`. Pass requires the success line and `plugin list` showing `ultrathink@ultrathink` with `enabled`.
4. Load (informational, not a pass criterion): `"$CLI" -p "/reload-plugins"` in `$ISO/work`. Older hosts print `Unknown skill` or `isn't available`.
5. Invoke: `"$CLI" -p "/ultrathink-status"` in `$ISO/work`. Pass requires exit 0 and the output to contain `Prompt Uplift on`. Exit 0 alone is not evidence: several failing runs exited 0 with empty output.
6. Uninstall: `"$CLI" plugin uninstall ultrathink`, then `"$CLI" plugin marketplace remove ultrathink`.
7. Delete `$ISO` (home, npm tree, npm cache, work dir).

Limit: `/ultrathink-status` is answered by the `UserPromptSubmit` hook. It makes no model call and needs no login. This run therefore does not exercise the planner or model path. The 2.1.322 floor record (`docs/validation/results/claude-code.md`) used a planner invoke that needed login.

No credential was copied or printed. No login was used, so nothing was copied and then deleted.

## Versions tested

Verdicts come from the per-run logs in `/tmp/ut-min-cc/<V>.log`. "Content-checked" means the `checks:` line in the log was produced by the final runner (`lifecycle3.sh`, same steps as above). Earlier runs (`lifecycle.sh`) were checked by exit code plus a manual grep for `Prompt Uplift on`.

| Version | Runner | Install | Marketplace add | Plugin install | Enabled | Invoke (exit; hook output) | Uninstall | Verdict |
|---|---|---|---|---|---|---|---|---|
| 2.1.322 (floor) | not rerun here | — | — | — | — | — | — | Record in `claude-code.md` (2026-11-13 and 2026-11-15) |
| 2.1.321 | lifecycle.sh | 0 | 0 | 0 | 0 | 0; `Prompt Uplift on` present | 0 | PASS (predecessor of floor; 2.1.320 is not published on npm) |
| 2.1.300 | lifecycle.sh | 0 | 0 | 0 | 0 | 0; present | 0 | PASS |
| 2.1.280 | lifecycle.sh | 0 | 0 | 0 | 0 | 0; present | 0 | PASS |
| 2.1.250 | lifecycle.sh | 0 | 0 | 0 | 0 | 0; present | 0 | PASS |
| 2.1.200 | lifecycle3.sh | 0 | 0 | 0 | 0 | 0; present | 0 | PASS (content-checked; first run invalid, see disk note) |
| 2.1.186 | lifecycle3.sh | 0 | 0 | 0 | 0 | 0; present | 0 | PASS (content-checked) |
| 2.1.179 | lifecycle3.sh | 0 | 0 | 0 | 0 | 0; present | 0 | PASS (content-checked) |
| 2.1.178 | not completed | — | — | — | — | — | — | **UNTESTED**: run stopped at wrap-up before a verdict |
| 2.1.177 | lifecycle3.sh | 0 | 0 | 0 | 0 | 0; **no hook output** | 0 | FAIL |
| 2.1.176 | lifecycle3.sh | 0 | 0 | 0 | 0 | 0; **no hook output** | 0 | FAIL |
| 2.1.174 | lifecycle3.sh | 0 | 0 | 0 | 0 | 0; **no hook output** | 0 | FAIL |
| 2.1.150 | lifecycle3.sh | 0 | 0 | 0 | 0 | 0; **no hook output** | 0 | FAIL |
| 2.1.100 | lifecycle3.sh | 0 | 0 | 0 | 0 | 0; **no hook output** | 0 | FAIL |
| 2.1.51 | lifecycle.sh (first run) | 0 | 0 | 0 | — | 1 (nested-session guard) | 0 | **Invalid run**: inherited `CLAUDECODE` tripped the guard. Not rerun after the fix, so untested |
| 2.0.0 | lifecycle.sh | 0 | 1 (`Invalid API key · Please run /login`) | 1 (`unknown option '--scope'`) | — | 0; empty | 1 | FAIL |
| 1.0.33 | lifecycle.sh | 0 | 1 (`Invalid API key · Please run /login`) | 1 (`unknown option '--scope'`) | — | 1 (`Invalid API key`) | 1 | FAIL |
| 1.0.0 | lifecycle.sh | 0 | hung (no output for over 10 min; killed) | not reached | — | not reached | — | No verdict |

The "no hook output" failures at 2.1.100 to 2.1.177 show the plugin installed and enabled, and `/ultrathink-status` exited 0 with empty output. Probe at 2.1.150 (stream-json, `--debug hooks`, plain prompt): no `system/informational` hook event, no `ultrathink/` state directory written under `CLAUDE_CONFIG_DIR`. The plugin's `slash_commands` are listed in `init`, so the plugin loads. The `UserPromptSubmit` hook does not produce output. The cause was not isolated.

## Disk note (affects the first runs only)

The root filesystem was at 100% use during the sweep (shared with other workloads). Several first-pass runs failed with `ENOSPC`, not with a version fault: 2.1.200 (`plugin install` copy failed), 2.1.150 and 2.1.100 (native binary missing after `TAR_ENTRY_ERROR ENOSPC`). These runs were discarded. Each was rerun with `lifecycle3.sh`, which retries install until `--version` succeeds and waits for free space. Those reruns are the results above.

## Cleanup

- Each run deleted its `$ISO` tree; the log line `cleanup: iso removed=yes` is recorded.
- The killed 2.1.178 run: its orphaned invoke process was killed and `/tmp/ut-min-cc/2.1.178` was deleted. Confirmed absent.
- The hung 1.0.0 run: killed, `/tmp/ut-min-cc/1.0.0*` deleted.
- Probe directory for 2.1.150 deleted.
- No credential file was copied into any isolated tree. None was read or printed.
- Logs and the runner scripts remain in `/tmp/ut-min-cc/` (outside the repo, no secrets).
- Nothing in this worktree was changed except this file. Not committed.

## Not tested

- The floor 2.1.322 was not rerun in this pass.
- 2.1.178 (the one release that decides the boundary).
- 2.1.101 to 2.1.149 and 2.1.151 to 2.1.173, and every release below 2.1.100 except 2.0.0, 1.0.33, 1.0.0 and the invalid 2.1.51 run.
- The model/planner path (no login was used).
- Install from the GitHub marketplace; this run used the local checkout.
