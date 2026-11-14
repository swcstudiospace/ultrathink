# Claude Code: manual validation run

Host: Claude Code 2.1.322 (`claude --version` → `2.1.322 (Claude Code)`)
Date (YYYY-MM-DD): 2026-11-13
Host version: 2.1.322
Tester: MatrixClaudeCode
Pass or fail: **Fail** (steps 1–5, 7–9 pass; step 6 invoke did not produce an engine plan and the prompt returned an API error. Blocked by login and credit in this environment, not by the plugin's install or load.)

## Isolation

- Root: `/tmp/ut-matrix/claude-code/`, `HOME=/tmp/ut-matrix/claude-code/home`, `CLAUDE_CONFIG_DIR=/tmp/ut-matrix/claude-code/home/.claude`.
- Pre-mutation check (step 1, isolated env): `No plugins installed. Use \`claude plugin install\` to install a plugin.` exit 0. Isolation honored; no operator plugin visible.
- One read-only `ls -la /root/.claude/plugins` was run for comparison only. Nothing in the real home was written.
- Auth note: `claude auth status` under the isolated env reports an API key source naming the process environment variable. The key is inherited from the process environment, not from the isolated home. I did not copy any credential into the isolated home and did not unset the inherited key.
- **Security note:** while checking auth I printed `$ANTHROPIC_API_KEY` in a shell `echo` by mistake. The value is in this session's tool transcript and was not written to this file. The operator should rotate that key.

## Notes

- **Published version tested, not d455baf.** The marketplace was added from `swcstudiospace/claude-ultrathink` (GitHub). The installed plugin is `ultrathink@ultrathink` version `1.4.0`, `gitCommitSha` `d8e7c7ed8bea2fe725e7c0afb91b8975c4b21052` (merge of PR #88). This is not commit d455baf of this checkout.
- Bun on PATH: `/root/.local/share/reflex/bun/bin/bun`.
- The `[rtk] /!\ No hook installed` line appears in CLI output. It comes from an unrelated host wrapper, not from ultrathink.
- Step 5: the runbook says docs conflict on reload. Both attempts were run. A headless `-p` run has no interactive session, so "new session" was a fresh `claude -p` process.
- Step 6 hook result: the UserPromptSubmit hook **did fire** and wrote `ultrathink/last-plan.<sid>.json`, `last.json`, and `sessions/<sid>.{json,xml}` under the isolated config. Its planner engine failed with `Not logged in · Please run /login`, so the plan was a degraded fallback (`degraded: uplift, graph, fill:n1–n5, clarify`).
- Text-mode `-p` output does **not** show the hook output. It shows only the API error. The hook output is visible in `--output-format stream-json --verbose` as a `system/informational` event (quoted below).
- `awaiting_user_decision` was not exercised. The headless prompt never reached a model turn, so no `AskUserQuestion` was asked.
- Step 9 cache: the data directory `plugins/data/ultrathink-ultrathink` was removed. The versioned cache `plugins/cache/ultrathink/ultrathink/1.4.0` (7225 entries) remains after uninstall. The doc does not mention this.
- The `extraKnownMarketplaces` entry for `ultrathink` remains in the isolated `settings.json` after uninstall. This is expected: only the plugin was removed.
- Unverified items hit: none from the runbook's UNVERIFIED list, except the `claude plugin list` loaded-vs-installed distinction (recorded verbatim below).

## Steps (exact command, exit code, verbatim output)

**1.** `claude plugin list` → exit 0
```
No plugins installed. Use `claude plugin install` to install a plugin.
```

**2.** `claude plugin marketplace add swcstudiospace/claude-ultrathink` → exit 0
```
Adding marketplace…SSH not configured, cloning via HTTPS: https://github.com/swcstudiospace/claude-ultrathink.git
Refreshing marketplace cache (timeout: 120s)…
Cloning repository (timeout: 120s): https://github.com/swcstudiospace/claude-ultrathink.git
Clone complete, validating marketplace…
Cleaning up old marketplace cache…
✔ Successfully added marketplace: ultrathink (declared in user settings)
```

**3.** `claude plugin install ultrathink@ultrathink --scope user` → exit 0
```
Installing plugin "ultrathink@ultrathink"...✔ Successfully installed plugin: ultrathink@ultrathink (scope: user)
```

**4.** `claude plugin list` → exit 0 (final list for the install)
```
Installed plugins:

  ❯ ultrathink@ultrathink
    Version: 1.4.0
    Scope: user
    Status: ✔ enabled
```

**5a.** `claude -p "/reload-plugins"` → exit 0
```
Reloaded: 1 plugin · 12 skills · 5 agents · 7 hooks · 0 plugin LSP servers
```

**5b.** Fresh session (new headless process): `claude -p "Reply with the single word: pong"` → exit 1
```
Credit balance is too low
```

**6.** Submit a prompt headless. Text mode: `claude -p "Reply with the single word: pong"` → exit 1
```
Credit balance is too low
```
Repeated with `claude -p --debug hooks "Reply with the single word: pong"` → exit 1, same output, no hook lines.

Stream-json: `claude -p --output-format stream-json --verbose "Reply with the single word: pong"` → exit 1. Hook-relevant line, verbatim:
```
{"type":"system","subtype":"informational","content":"UserPromptSubmit says: Prompt Uplift · UPLIFTED_PROMPT · fallback · claude:claude-haiku-5-5 [route default] · reason route-default-model · engine auto (config) · Graph of Thought · 5 nodes · Degraded · uplift, graph, fill:n1, fill:n2, fill:n3, fill:n4, fill:n5, clarify · Substrate · brief 2 lines · Tracking · off · Engine error · Not logged in · Please run /login · 4.0s","level":"notice",...}
```
The remaining lines were `system/init`, one synthetic `assistant` message, and a `result` with `"terminal_reason":"api_error"`. The `result` line is truncated here at 600 chars; the full line is in `/tmp/ut-matrix/claude-code/stream.jsonl`. Only 4 lines total, so nothing was omitted from the stream.

Hook artifacts written (isolated config, `ultrathink/`): `last.json`, `last-plan.3445265f-….json`, `last-plan.c85f5495-….json`, `sessions/*.json`, `sessions/*.xml`. `last.json` records `"engineError": "Not logged in · Please run /login"`.

**7.** `claude plugin uninstall ultrathink` → exit 0
```
✔ Successfully uninstalled plugin: ultrathink (scope: user)
```

**8.** `claude plugin list` → exit 0 (final list)
```
No plugins installed. Use `claude plugin install` to install a plugin.
```

**9.** Data dir check: `plugins/data/ultrathink-ultrathink` before uninstall was present (ls showed `ultrathink-ultrathink/`). After uninstall: **ABSENT**. Cache `plugins/cache/ultrathink/ultrathink/1.4.0` **PRESENT** (7225 entries). `installed_plugins.json` → `{"version": 2, "plugins": {}}`.

## Lifecycle states

Install
- `not_installed`: observable (step 1).
- `installing`: not observable on this host (single CLI call, no progress output).
- `installed`: observable (step 4).
- `install_failed`: not observed (steps 2, 3, 4 all succeeded).

Load
- `loading`: not observable on this host.
- `loaded`: observable. Step 5a reports `Reloaded: 1 plugin · 12 skills · 5 agents · 7 hooks`. `claude plugin list` shows `Status: ✔ enabled`.
- `version_mismatch`: not observable on this host.
- `capability_missing`: not observable on this host.
- `load_failed`: not observed. No load error surfaced.

Invoke
- `idle`: not observable on this host.
- `running`: not observable on this host.
- `awaiting_user_decision`: not observed. The session never asked a question, so the `AskUserQuestion` hook did not run.
- `succeeded`: not observable on this host.
- `failed`: not reached through the install doc's surface. The invoke ended with `terminal_reason: api_error` ("Credit balance is too low") and the planner degraded (`Not logged in`). Recorded as blocked, not as a plugin failure.
- `cancelled`: not observable on this host.

## Blockers

- **Login (isolated home):** the planner subprocess under `CLAUDE_CONFIG_DIR` has no credentials. Verbatim: `Not logged in · Please run /login`. Per rule 6, I did not copy credentials into the isolated home.
- **Credit (inherited key):** the inherited `ANTHROPIC_API_KEY` returns `Credit balance is too low`. A real model turn could not complete, so the "submit a prompt → model answers" path was not verified.

To finish step 6 for real, run it with credentials that are valid for this account in the isolated home (for example, `claude /login` run inside `CLAUDE_CONFIG_DIR`) or with an API key that has credit. Then repeat step 6 and record whether the planner returns `engine` output instead of `degraded`.

## Invoke rerun with copied login (orchestrator-approved)

Scope: step 6 only (submit a prompt, observe UserPromptSubmit hook). Date: 2026-11-13. Host: Claude Code 2.1.322.

**Plugin source.** The isolated home had no plugin (step 7 of the earlier run uninstalled it). `claude plugin marketplace add swcstudiospace/claude-ultrathink` reported the marketplace `ultrathink` already on disk (GitHub `swcstudiospace/claude-ultrathink`, the published marketplace). `claude plugin install ultrathink@ultrathink --scope user` → exit 0, `Successfully installed plugin: ultrathink@ultrathink (scope: user)`. `claude plugin list` → `ultrathink@ultrathink`, `Version: 1.4.0`, `Scope: user`, `Status: ✔ enabled`. The plugin was left installed after this run.

**Login copy (rule 2).** Copied only the login-holding data into the isolated home: `/root/.claude/.credentials.json` → `$CLAUDE_CONFIG_DIR/.credentials.json` (mode 600). The login's `oauthAccount` key lives in `/root/.claude.json`. I merged that single key into the isolated `$CLAUDE_CONFIG_DIR/.claude.json` instead of copying the whole real file, because the real file carries unrelated project and cache state. This is a narrower copy than rule 2's literal wording. Contents were not printed.

**Command (exit code 0, wall time 54.8 s).**
```
env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN HOME=/tmp/ut-matrix/claude-code/home CLAUDE_CONFIG_DIR=/tmp/ut-matrix/claude-code/home/.claude PATH=/root/.local/share/reflex/bun/bin:$PATH timeout 600 claude -p "ultrathink invoke rerun: reply with the single word ok" --output-format stream-json --verbose > /tmp/ut-matrix/claude-code/invoke-rerun.jsonl 2> /tmp/ut-matrix/claude-code/invoke-rerun.stderr.txt
```
Output: 7 stream-json lines, stderr empty. Not truncated.

**Hook output: appeared.** Verbatim `system/informational` event:
```
UserPromptSubmit says: Prompt Uplift · UPLIFTED_PROMPT · llm · claude:claude-haiku-5-5 [route default] · reason route-default-model · engine auto (config) · Graph of Thought · 5 nodes · Degraded · graph · Substrate · brief 2 lines · Tracking · off · 47.8s
```
The result event: `is_error: false`, `subtype: success`, `terminal_reason: completed`, `num_turns: 1`. The assistant replied `ok`.

**Plan state.** The session file `ultrathink/sessions/b7e2d07e-….json` records `engine: "claude:claude-haiku-5-5"` and `degraded: ["graph"]`. The plan body has a `## Planning degraded` note: "the graph structure use fallback content — treat those parts as unverified." Only the graph stage degraded. The earlier run degraded all four stages (`uplift, graph, fill, clarify`). The artifacts do not record why the graph calls failed.

**Deletion verification (rule 5).** `rm` of `.credentials.json`, then `del(.oauthAccount)` on the isolated `.claude.json`. `ls $CLAUDE_CONFIG_DIR/.credentials.json` → `No such file or directory`. `has("oauthAccount")` → `false`. A recursive grep of the isolated home for `"accessToken"`/`"refreshToken"` (file names only) → no matches. Stream output has no token field names. No key or token was printed in this section.

**Verdict (invoke step): partial pass.** The UserPromptSubmit hook fired, and the planner ran through the LLM engine with a real model reply. The graph stage degraded, and the cause is unrecorded, so the plan is not a full engine plan. Not exercised: `awaiting_user_decision`.

## Live recheck after graph-prompt fix

Scope: headless invoke step only, on this checkout (branch `plugin-core-slice`, working tree including the `<original>` guard in `src/think/prompts.ts`). Date: 2026-11-13. Host: Claude Code 2.1.322. Tester: ClaudeLiveRecheck.

**Local install: possible.** The isolated marketplace `ultrathink` was switched from the GitHub build to a folder source:

```
claude plugin marketplace remove ultrathink      # also uninstalled ultrathink@ultrathink 1.4.0
claude plugin marketplace add /root/src/repos/claude-ultrathink
claude plugin install ultrathink@ultrathink -y
```

Result: `Successfully installed plugin: ultrathink@ultrathink (scope: user)`; `claude plugin list` shows `Read from: /root/src/repos/claude-ultrathink`, `Version: 1.4.0`, `Status: ✔ enabled`. The versioned cache copies of `src/think/prompts.ts` and `hooks/uplift.ts` are byte-identical to the checkout (`diff -q`). The manifest version did not change, so `1.4.0` does not identify the build.

**Login copy.** Copied `/root/.claude/.credentials.json` (mode 600) and merged only the `oauthAccount` key from `/root/.claude.json` into the isolated `.claude.json`. Contents were not printed. `ANTHROPIC_API_KEY` was unset for every command.

**Command (exit 0, wall 99.2 s, cwd `/tmp/ut-matrix/claude-code/work`):**

```
env -u ANTHROPIC_API_KEY CLAUDE_CONFIG_DIR=/tmp/ut-matrix/claude-code/home/.claude claude -p "reply with the single word ok" --output-format stream-json --verbose > /tmp/ut-matrix/claude-code/run-live.jsonl 2> /tmp/ut-matrix/claude-code/run-live.err
```

stderr: 0 bytes. stream-json: 6 lines (`system/init`, `system/informational`, `assistant`, `rate_limit_event`, `system/informational`, `result`).

Verbatim hook lines (`system/informational`):

```
UserPromptSubmit says: Prompt Uplift · UPLIFTED_PROMPT · llm · claude:claude-haiku-5-5 [route default] · reason route-default-model · engine auto (config) · Jev · unavailable: OpenRouter reports insufficient credits since 2026-11-13. Decisions fall back to their defaults until you top up at https://openrouter.ai/settings/credits (next check 2026-11-13T05:51:17Z). · Graph of Thought · 7 nodes · Substrate · brief 2 lines · Knowledge · none · Decisions · error (credits) · Tracking · 7 issues · 49 sub-issues linked · 93.8s
Stop says: Ultrathink · this turn tracked a task (graphId=ut-6fc5b4a73f-a910f9c2). If the work reached a stopping point worth recording, invoke the ultrathink-sync skill before the session ends.
```

**Graph status: not degraded.** The summary has `Graph of Thought · 7 nodes` and no `Degraded · graph`. The session artifact `ultrathink/sessions/9d6c7ffe-….json` has `engine: "claude:claude-haiku-5-5"` and no `degraded` key. This run's prior comparison (`degraded: uplift, graph, fill, clarify` on the 1.4.0 build, and `degraded: ["graph"]` on the copied-login rerun) is no longer present. The `Jev` and `Decisions` stages report OpenRouter credit errors. These do not appear in a `Degraded ·` list and were not part of the graph stage.

**Reply.** Assistant text: `ok`. Result: `subtype: success`, `is_error: false`, `terminal_reason: completed`, `num_turns: 1`.

**Side effect (cancelled; source not identified; owner decision needed).** The `Tracking` stage was on and created Linear issues in team `Spectrum Web Co` (workspace `swcstudio`): `SPE-31017` through `SPE-31023` (7 node issues) and 49 step sub-issues (`SPE-31024` through `SPE-31072`). The earlier 1.4.0 run reported `Tracking · off`. The tracking source was not identified, so the cause is still open; the owner must decide whether tracking stays enabled for validation runs. All 56 were set to Canceled (Linear has no delete tool); none was deleted.

**Login deletion (verified).** `.credentials.json` removed; `oauthAccount` deleted from the isolated `.claude.json`. `ls` → `No such file or directory`; `has("oauthAccount")` → `false`. Value-level scans (checked 2026-11-14) for non-empty `"accessToken"`/`"refreshToken"` string values found none in the isolated validation homes under `/tmp/ut-matrix`, the committed repos, or the Claude and Omp plugin directories. The one key-name hit in a plugin cache is a third-party security-guidance test fixture whose values are placeholders (`"old"`, `"new-and-longer"`), not credentials.

**Verdict (invoke step, this checkout): pass.** The UserPromptSubmit hook fired, the Claude graph stage was not degraded, and the reply came back as `ok`. Not exercised: `awaiting_user_decision`.

