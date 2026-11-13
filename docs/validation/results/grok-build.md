# Grok Build: manual validation run

Host: Grok Build
Date (YYYY-MM-DD): 2026-11-13
Host version: `grok --version` → `grok 1.0.77 (50ca579fa996) [stable]`
Tester: MatrixGrokBuild (worker agent, isolated home)
Pass or fail: **Fail (incomplete).** Install, install-verification, component inventory, disable/enable, and uninstall passed. Load (step 5) was not run because it is interactive-only. Invoke (step 6) was blocked by login, so no hook output was observed.

## Isolation

- Isolated root: `/tmp/ut-matrix/grok-build/`; `HOME=/tmp/ut-matrix/grok-build/home`; `GROK_HOME=/tmp/ut-matrix/grok-build/home/.grok`. Every command below was run with these set.
- Pre-mutation check (step 1, before install): `No plugins installed.` Isolation honored. No operator plugin was visible.
- No real credentials were copied into the isolated home. No `~/.grok` under the real home was touched.
- Checkout: `git status` after the run shows only pre-existing untracked `.gsd-run/` and this results file. No checkout files were modified.

## Trust decision

Install used `--trust` because `/root/src/repos/claude-ultrathink` is the operator's own checkout. Without `--trust`, Grok would prompt. Trust state is not shown by `grok plugin list` or `grok plugin details`. `config.toml` does not record it. Trust state is therefore UNVERIFIED on this host, and the install was trusted by flag only.

## Steps

### Step 1: `grok plugin list` (before install)

Command: `grok plugin list` · Exit: 0
```
No plugins installed. Run `grok plugin install --help` to get started.
```
Result: ultrathink not listed. Pre-install state observed (`not_installed`).

### Step 2: install from checkout

Command: `grok plugin install /root/src/repos/claude-ultrathink --trust` · Exit: 0 · Wall time 17.54 s
```
Installed 1 plugin(s) from /root/src/repos/claude-ultrathink: ultrathink
```

### Step 3: `grok plugin list` (after install)

Command: `grok plugin list` · Exit: 0
```
  claude-ultrathink-dc480685: ultrathink [local: /root/src/repos/claude-ultrathink]
```
Result: local-path install is listed. The runbook's UNVERIFIED caveat on local-path visibility is now resolved for this host.

### Step 4: `grok plugin details ultrathink`

Command: `grok plugin details ultrathink` · Exit: 0
```
claude-ultrathink-dc480685
  path: /tmp/ut-matrix/grok-build/home/.grok/installed-plugins/claude-ultrathink-dc480685
  kind: local: /root/src/repos/claude-ultrathink
  installed: 2026-11-13T04:24:11.067436234+00:00
  updated: 2026-11-13T04:24:11.067436234+00:00
  plugins (1):
    ultrathink v1.4.0
  description: Plans every prompt into a spec + Graph of Thought with HITL clarifications on a pluggable engine (Claude default, Grok optional), tracks it in Linear/Notion, and ships finished work through a Greptile-gated PR.
  components: 1 skill dir(s), 1 command dir(s), 0 agent dir(s), hooks
```
Result: inventory shows skills, commands, and hooks. Format is undocumented; recorded verbatim.

### Step 5: `/plugins`, press `r` in Plugins tab, or new session

Not run: interactive only. No headless equivalent for this step exists in `grok --help`, so the reload was not performed. Load-state observations are therefore not made.

### Step 6: submit a prompt (UserPromptSubmit hook)

Command: `grok -p "Say OK in one word."` · Exit: 1
```
Not signed in. To authenticate without a browser, run:
  grok login --device-code

Alternatively, set the XAI_API_KEY environment variable or run `grok login` on a machine with a browser.
Error: Not signed in. To authenticate without a browser, run:
  grok login --device-code

Alternatively, set the XAI_API_KEY environment variable or run `grok login` on a machine with a browser.
```
Result: **blocked by login.** The isolated home has no credentials, and I did not copy any in. No hook output was observed. Invoke-state observations are therefore absent.

### Step 7 (optional): disable, then enable

Command: `grok plugin disable ultrathink` · Exit: 0
```
Disabled plugin: ultrathink
```
Command: `grok plugin list` (while disabled) · Exit: 0
```
  claude-ultrathink-dc480685: ultrathink [local: /root/src/repos/claude-ultrathink]
```
`config.toml` while disabled:
```
[plugins]
enabled = []
disabled = ["ultrathink"]
```
Command: `grok plugin enable ultrathink` · Exit: 0
```
Enabled plugin: ultrathink
```
`config.toml` after enable:
```
[plugins]
enabled = ["ultrathink"]
disabled = []
```
Result: disable and enable both work. `grok plugin list` shows no enabled or disabled marker. The state is visible only in `config.toml`.

### Step 8: `grok plugin uninstall ultrathink` (default, data dir removed)

Command: `grok plugin uninstall ultrathink` · Exit: 0
```
Uninstalled 1 plugin(s): ultrathink
```

### Step 9: `grok plugin list` (after uninstall)

Command: `grok plugin list` · Exit: 0
```
No plugins installed. Run `grok plugin install --help` to get started.
```
Post-uninstall residue (isolated home):
- `installed-plugins/registry.json` = `{"version": 1, "repos": {}}`. The plugin entry is gone.
- `installed-plugins/` contains only `registry.json` and `registry.lock`. The plugin directory `claude-ultrathink-dc480685/` was removed.
- `config.toml` still contains `enabled = ["ultrathink"]`. Uninstall does not clear this stale entry. Recorded as a residue observation.

## Lifecycle states

Install
- `not_installed`: observable. Step 1 shows no plugins. Step 1 is the only pre-install list.
- `installing`: not observable. The install is one synchronous command with no progress output. Install took 17.54 s wall time.
- `installed`: observable. Steps 3 and 4 list ultrathink with its component inventory. Trust state is not observable (see Trust decision).
- `install_failed`: not observed. Step 2 exited 0.

Load
- `loading`: not observable. No load output was emitted; step 5 was not run.
- `loaded`: not observed. Step 4 shows the install-time inventory, not a load after reload. Step 5 was not run.
- `version_mismatch`: not observable. No version check is documented.
- `capability_missing`: not observable. The repo declares no MCP servers or `allowed-tools`.
- `load_failed`: not observable. No load error surface is documented.

Invoke
- `idle`: not observed. No prompt was accepted (step 6 blocked by login).
- `running`: not observable.
- `awaiting_user_decision`: not observable. The `AskUserQuestion` matcher is unverified on Grok.
- `succeeded`: not observed (blocked by login).
- `failed`: not observed (blocked by login).
- `cancelled`: not observable.

Uninstall
- Removal observed (steps 8 and 9). Plugin dir removed. `registry.json` clean. `config.toml` enabled entry left behind.

## Notes

- Step 5 (`/plugins`) is interactive-only; not run. No headless reload equivalent exists in `grok --help`.
- Step 6 is blocked by login. To complete it, the operator must sign in to the isolated home with `grok login --device-code` (or set `XAI_API_KEY`), then rerun `grok -p` and capture hook output. I did not do either.
- Trust state is not displayed by any command in the runbook. Install was trusted by `--trust`. UNVERIFIED.
- `grok plugin list` shows no enabled or disabled marker. The state is observable only in `config.toml`.
- Uninstall leaves `enabled = ["ultrathink"]` in `config.toml`. Observed; not a runbook step.
- Runbook caveat resolved: local-path install appears in `grok plugin list` (step 3).

## Invoke rerun with copied login (orchestrator-approved)

Date: 2026-11-13. Host: `grok --version` → `grok 1.0.77 (50ca579fa996) [stable]`. Scope: runbook step 6 only. Tester: InvokeRerunGrok.

### Plugin reinstall

The earlier run uninstalled the plugin, so it was installed again in the isolated env.

Command: `grok plugin install /root/src/repos/claude-ultrathink --trust` · Exit: 0 · Wall 11.51 s
```
Installed 1 plugin(s) from /root/src/repos/claude-ultrathink: ultrathink
```
`grok plugin list` after: `claude-ultrathink-dc480685: ultrathink [local: /root/src/repos/claude-ultrathink]`.

### Login copy

Only `/root/.grok/auth.json` (mode 600) was copied to `$GROK_HOME/auth.json` with `cp -p`. Its contents were not printed. No other file was copied. The real file was not written by this run: its mtime is `2026-11-12 22:12:49 UTC`, before the run.

### Invoke

Environment: `HOME=/tmp/ut-matrix/grok-build/home`, `GROK_HOME=/tmp/ut-matrix/grok-build/home/.grok`, working directory `/root/src/repos/claude-ultrathink`.

Command: `env -u ANTHROPIC_API_KEY -u XAI_API_KEY timeout 240 grok -p "Say OK in one word."` · Exit: 0 · Wall 156.90 s. The shell moved the call to a background job after about 60 s; it finished on its own.

Output (full, 343 bytes, 2 lines, not truncated):
```
I'll check the ultrathink plan for this turn first, then reply.I'll locate this session's plan file next.permission required: Execute `echo "SESSION_HINT=$GROK_SESSION_ID"; echo "ULTRATHINK_STATE_DIR=$ULTRATHINK_STATE_DIR"; echo "GROK_PLUGIN_DATA=$GROK_PLUGIN_DATA"; echo "GROK_HOME=… was not run, as
 a headless run cannot ask for approval
```

Hook evidence, from the isolated session transcript `sessions/%2Froot%2Fsrc%2Frepos%2Fclaude-ultrathink/01a1d340-a924-7740-bb9f-6ed48348b31a/updates.jsonl`:

- `hook_execution`: event `user_prompt_submit`, run `plugin/ultrathink/hooks:user_prompt_submit[0].hooks[0]`, status `success`, elapsed 145812 ms.
- `hook_annotation`: "Prompt Uplift · UPLIFTED_PROMPT · llm · grok:grok-build-0.1 [route default] · reason route-default-model · engine auto (config) · Graph of Thought · 6 nodes · Substrate · brief 13 lines · Tracking · off · 145.3s".
- Plan file written: `plugin-data/user/95ebd55b/ultrathink/ultrathink/last-plan.01a1d340-a924-7740-bb9f-6ed48348b31a.json`, 15171 bytes, graph id `ut-00da624882-799720ff`.

The first stdout line ("I'll check the ultrathink plan…") matches the hook's instruction to read the plan file. Stdout carries no hook-tagged marker, so the transcript records are the attribution.

The agent's follow-up bash call, which reads the plan, needed approval. `grok -p` cannot ask for approval, so the call was refused. The run ended with no answer text ("OK" was not produced). Exit stayed 0.

### Deletion verification

Command: `rm -f "$GROK_HOME/auth.json"` · Exit: 0.
`ls -la "$GROK_HOME/auth.json"` → `No such file or directory`. `find /tmp/ut-matrix/grok-build/home -name 'auth*.json'` → 0 matches.
`auth.json.lock` (18 B) remains in `$GROK_HOME`. grok created it during the run; it is a lock file, not a copy of login data.

### Verdict (invoke step)

- Hook fired and succeeded: observed (transcript records above).
- Planned result written: observed (plan file above).
- Final answer to the prompt: not produced. The headless run refused the plan-reading tool call, which needs approval.

Step 6 documented result ("the hook plans the prompt") is observed. The full invoke path is not, because the post-plan tool call was denied under `-p`.

### Notes

- Not verified: whether the isolated run rotated the refresh token server-side. The real `auth.json` was not modified locally.
- The plugin remains installed in the isolated home. This section does not uninstall it.

