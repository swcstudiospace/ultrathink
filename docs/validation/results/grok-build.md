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
