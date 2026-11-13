# Muse Code validation run

```
Host: Muse Code
Date (YYYY-MM-DD): 2026-11-13
Host version: Muse Code 1.4.18 (1.4.18-R8587.1), from `muse --version`. Runbook observed 1.4.14; not matched.
Tester: MatrixMuse (subagent, isolated HOME)
Pass or fail: FAIL
Notes: see below.
```

## Isolation

- Root: `/tmp/ut-matrix/muse/`, `HOME=/tmp/ut-matrix/muse/home`. No other config env var (runbook: HOME only).
- Repo checkout: `/root/src/repos/claude-ultrathink`, branch `plugin-core-slice`, commit `d455baf`.
- Isolated list before any mutation (step 1): `no plugins`. Isolation honored; no operator plugins visible.
- One deviation, disclosed: during version discovery I ran `muse --version` and `muse plugins list` without the HOME override. Both are read-only. The real `muse plugins list` printed `no plugins`, matching the operator's statement. No mutating command ran against the real home.
- Other peers write into this checkout concurrently (`docs/validation/results/*.md`, `.gsd-run/`). This is relevant to step 2 (see Notes).

## Step 1: list before install

```
$ HOME=/tmp/ut-matrix/muse/home muse plugins list
no plugins
exit=0
```
Ultrathink not listed. State `not_installed`: observable.

## Step 2: install

Command used (as the runbook specifies; scope set to `user` explicitly; the doc gives no default):

```
$ cd /root/src/repos/claude-ultrathink && muse plugins install . --scope user
diagnostic=multiple-manifests severity=warning path=/root/src/repos/claude-ultrathink message=selected `.muse-plugin/plugin.json`; ignoring `.claude-plugin/plugin.json`
diagnostic=invalid-plugin-package severity=error path=/root/src/repos/claude-ultrathink message=Agent Definition inventory derivation failed closed
exit=1
```

Repeated without the gate (`--scope user`, same command, second attempt):

```
$ muse plugins install . --scope user
diagnostic=multiple-manifests severity=warning path=/root/src/repos/claude-ultrathink message=selected `.muse-plugin/plugin.json`; ignoring `.claude-plugin/plugin.json`
diagnostic=invalid-plugin-package severity=error path=/root/src/repos/claude-ultrathink message=Agent Definition inventory derivation failed closed
exit=1
```

Third non-gate attempt, with `--json`:

```
$ muse plugins install . --scope user --json
{
  "error": {
    "code": "invalid-plugin-package",
    "message": "held project plugin source inventory changed during snapshot"
  }
}
held project plugin source inventory changed during snapshot
exit=1
```

Gate rule applied (step 2 failed): repeated with `MUSE_EXPERIMENTAL_PLUGINS=1`.

Gated attempt 1 (no `--json`):

```
$ MUSE_EXPERIMENTAL_PLUGINS=1 muse plugins install . --scope user
held project plugin source inventory changed during snapshot
exit=1
```

Gated attempt 2 (`--json`) succeeded, exit 0. Output was about 130 lines. The head and key fields are kept verbatim below; the omitted middle is only hook and skill source-path entries:

```
{
  "diagnostics": [ { "code": "multiple-manifests", "severity": "warning", "path": "/root/src/repos/claude-ultrathink", ... } ],
  "installed": {
    "cache_path": "/tmp/ut-matrix/muse/home/.local/share/muse/plugins/cache/local/ultrathink/37805e5a51f49fd7d6b2458cc460054318470289084aab16ac9fed00322b1f05/package",
    "enabled": true,
    "id": "ultrathink",
    "manifest_family": "native",
    "source": { "path": "/root/src/repos/claude-ultrathink", "provenance": "native-local" },
    "trust": "user-local",
    "version": "1.4.0"
  },
  "lockfile_path": "/tmp/ut-matrix/muse/home/.local/share/muse/plugins/installed.json",
  "plugin": { "capabilities": { "commands": [6 entries], "hooks": [3 entries], "mcp_servers": [], "reminders": [], "session_providers": [], "skills": [5 entries] } },
  "warning": "third-party plugin: hooks require review before activation; skills and commands are active without review while the plugin is enabled"
}
exit=0
```

Install command that succeeded: `MUSE_EXPERIMENTAL_PLUGINS=1 muse plugins install . --scope user --json` (exit 0).

Summary for step 2:
- Without gate: exit 1 on 3 of 3 attempts. Error text: "Agent Definition inventory derivation failed closed" (attempts 1 and 2), then "held project plugin source inventory changed during snapshot" (attempt 3).
- With gate: exit 1 on attempt 1, exit 0 on attempt 2. Attempt 1 has the same race error text as non-gate attempt 3.
- The "inventory changed during snapshot" error is consistent with concurrent writes into the checkout by peer runs during the snapshot. Before the gated success I observed new untracked files appearing under `docs/validation/results/` and `.gsd-run/`. This is [INFERENCE]; I did not isolate it further.
- `muse plugins validate .` passed at the same time (see step 2b), so the manifest itself is valid.

Install state: `install_failed` observable for the non-gate attempts and the first gated attempt. `installed` observable after the gated attempt 2.

## Step 2b: validate (diagnostic, not a runbook step)

```
$ muse plugins validate .
diagnostic=multiple-manifests severity=warning path=. message=selected `.muse-plugin/plugin.json`; ignoring `.claude-plugin/plugin.json`
diagnostic=invalid-plugin-package severity=warning path=/root/src/repos/claude-ultrathink/hosts/prime-agent/.venv/bin/python message=plugin contains symlink entries that escape the package root and will be dropped at install
valid	ultrathink	native	skills=5 commands=6 hooks=3 mcp=0 reminders=0 diagnostics=2
exit=0
```

The `.venv` symlink warning matches the install doc's known-limitations entry. The "will be dropped at install" wording suggests a symlink could affect the snapshot, but I did not confirm that.

## Step 3: approve

Before a successful install, approve failed as expected:

```
$ muse plugins approve ultrathink     (non-gate, after failed install)
plugin `ultrathink` is not installed
exit=1
$ MUSE_EXPERIMENTAL_PLUGINS=1 muse plugins approve ultrathink     (gate, after failed install)
plugin `ultrathink` is not installed
exit=1
```

After the gated install succeeded:

```
$ muse plugins approve ultrathink     (no gate)
approve	plugin:ultrathink:hook:post-tool-use
approve	plugin:ultrathink:hook:stop
approve	plugin:ultrathink:hook:user-prompt-submit
exit=0

$ MUSE_EXPERIMENTAL_PLUGINS=1 muse plugins approve ultrathink     (gate)
approve	plugin:ultrathink:hook:post-tool-use
approve	plugin:ultrathink:hook:stop
approve	plugin:ultrathink:hook:user-prompt-submit
exit=0
```

Approve works both with and without the gate once the plugin is installed. Whether the gate is needed for install is not settled by this run, because install behaved nondeterministically.

## Step 4: list after approve

```
$ muse plugins list
ultrathink	1.4.0	enabled=true active=true trust=user-local provenance=native-local valid=true diagnostics=1
warning	third-party plugin: hooks require review before activation; skills and commands are active without review while the plugin is enabled
exit=0
```

Confirmed listed.

## Step 5: inspect

```
$ muse plugins inspect ultrathink
ultrathink	1.4.0	enabled=true active=true trust=user-local valid=true skills=5 commands=6 hooks=3 mcp=0 reminders=0 agents=0 cache=/tmp/ut-matrix/muse/home/.local/share/muse/plugins/cache/local/ultrathink/37805e5a51f49fd7d6b2458cc460054318470289084aab16ac9fed00322b1f05/package
warning	third-party plugin: hooks require review before activation; skills and commands are active without review while the plugin is enabled
runtime-capability	plugin:ultrathink:hook:post-tool-use	status=trusted_enabled
runtime-capability	plugin:ultrathink:hook:stop	status=trusted_enabled
runtime-capability	plugin:ultrathink:hook:user-prompt-submit	status=trusted_enabled
exit=0
```

Load state `loaded`: observable only indirectly. `inspect` reports `trusted_enabled` for all three hooks. It does not separate loaded from installed. Recorded verbatim as the doc requires.

## Step 6: new session

The runbook says "start a new session". I did not use the interactive TUI, so no session was started by hand. Step 7 ran as a new headless session (`muse exec`, new session id `01a1d329-19bb-7620-8421-1ad20590bbe8`). Hook load from a new session is therefore not separately confirmed.

## Step 7: prompt (headless)

`muse -p` is not a flag on this build. The headless command is `muse exec`.

Default provider (meta):

```
$ HOME=/tmp/ut-matrix/muse/home muse exec "Plan a small change: add a README line. /ultrathink-status"
missing meta credentials: run `muse login` or set META_API_KEY, or save credentials at /tmp/ut-matrix/muse/home/.config/muse/auth.json
exit=1
```

Blocked by login. No real credentials were copied into the isolated home.

Echo provider (no credentials needed), `--json`:

```
$ muse exec --provider echo --json "Plan a small change: add a README line."
muse: workspace root: /root/src/repos/claude-ultrathink (cwd default)
muse: Skills: 33 loaded · 1 warning
muse:   .claude: project-skills-untrusted: project skills skipped because workspace is untrusted
muse:   Run `muse skills list --source all` for full diagnostics.
muse: plugins: foreign:claude: foreign claude plugin artifact observed as diagnostics only; observe-only by default (/root/src/repos/claude-ultrathink/.claude-plugin/plugin.json)
muse: Agent delegation: auto unavailable: workspace is untrusted.
... (JSONL, 35 events; output truncated to 768 chars per line by the tool; events 10-28 omitted) ...
{"...","payload_type":"run.terminal.completed",..., "terminal":"completed","text":"echo: Plan a small change: add a README line."}
exit=0
```

Event payload types observed: `runtime.command.accepted`, `session.run.linked`, `session.workspace_branch.observed` (`probe_degraded_reason: skipped_untrusted`), `turn.input.user`, `run.lifecycle.started`, `task.stream.linked`, `task.lifecycle.*` (for `reminder.agent.skill-reminder` and `reminder.verify-reminder`), `run.usage`, `run.terminal.completed`.

I grepped the full artifact for `hook`, `plugin`, and payload types matching `hook|plugin|extension|capabilit`. The grep found no plugin hook event. The `UserPromptSubmit` hook (`hooks/muse-prompt` -> `hooks/uplift.ts`) did not show in the stream, and no ultrathink plan appeared in the output. Hook execution is therefore not observable in the headless output, and I could not confirm it ran.

**Superseded 2026-11-13:** this check read only stdout, and the hook did run. See the correction under Pass or fail.

Invoke state: `idle`, `running`, `awaiting_user_decision`, `succeeded`, `failed`, `cancelled` all not observable on this host (the runbook says the same).

Step 7 result: prompt ran headless on the echo provider, exit 0. The hook effect was not observed. The meta provider run was blocked by login.

**Superseded 2026-11-13:** the hook effect is recorded in the session log, not stdout. See the correction under Pass or fail.

## Step 8: remove

```
$ muse plugins list          (before remove; isolated, ultrathink only)
ultrathink	1.4.0	enabled=true active=true trust=user-local provenance=native-local valid=true diagnostics=1
...
$ muse plugins remove ultrathink
removed	ultrathink
exit=0
```

`--delete-data` was not used.

## Step 9: list after remove

```
$ muse plugins list
no plugins
exit=0
```

Confirmed gone. `installed.json` now reads `{ "version": 1, "plugins": {} }`.

Leftover data: `~/.local/share/muse/plugins/data/ultrathink/` (an empty directory) remains. Also `cache/local/` (empty). Without `--delete-data`, the plugin data directory is kept. The runbook does not document this path; I observed it under the isolated home.

## Lifecycle states

Install
- `not_installed`: observable. Step 1 shows `no plugins`.
- `installing`: not observable on this host.
- `installed`: observable. Steps 4 and 5 list and inspect ultrathink.
- `install_failed`: observable. Non-gate attempts exit 1 (3/3), and the first gated attempt exits 1.

Load
- `loading`: not observable on this host.
- `loaded`: observable only indirectly. `inspect` shows `trusted_enabled` for all hooks. The doc does not define loaded versus installed output.
- `version_mismatch`: not observable on this host.
- `capability_missing`: not observable on this host.
- `load_failed`: not observable on this host. No load error surface found.

Invoke
- `idle`, `running`, `awaiting_user_decision`, `succeeded`, `failed`, `cancelled`: not observable on this host. The hook's effect did not show in the headless output.

## Unverified items hit

- Experimental gate (`MUSE_EXPERIMENTAL_PLUGINS=1`): run both ways as the runbook requires. Non-gate install failed 3/3; gated install succeeded on attempt 2 of 2 (attempt 1 failed). Install is not shown to depend on the gate, because the run was nondeterministic. Approve works both ways once installed.
- Scope default: not stated by the doc. I used `--scope user` explicitly.
- Hook execution in headless mode: not observed. See step 7.
- **Superseded 2026-11-13:** the session log records the hook; see the correction under Pass or fail.
- Plugin data directory path and `--delete-data`: observed only as above.

## Verbatim final `list`

```
$ muse plugins list
no plugins
exit=0
```

Final state: Muse is clean. No plugins are installed in the isolated home.

## Pass or fail

FAIL. Step 2 (`muse plugins install . --scope user`) exited non-zero without the experimental gate on 3 of 3 attempts. The gated install failed once, then succeeded. Steps 3 to 9 completed after the successful gated install, but step 7's hook effect is not observable and the default meta provider needs login.

**Correction, 2026-11-13.** The statements that the Muse hook did not run or was not observable (Step 7, this section, and the retry) are superseded. The check behind them read only `muse exec` stdout, which carries no hook events (`docs/install/muse.md`). The hook records to `session.jsonl` (`hook_run_terminal`) and to the `last-plan.<session-id>.json` state file. It fires once the plugin is approved, and Step 3 approved it before Step 7. Step 7's session `01a1d329-19bb-7620-8421-1ad20590bbe8` (`/tmp/ut-matrix/muse/home/.local/share/muse/sessions/2026/11/13/`) has a completed `hook_run_terminal` for `plugin:ultrathink:user-prompt-submit` (`exit_code` 0, `effects` `["context"]`), and its `last-plan` file names `"host": "muse"`. The retry's session `01a1d35c-43fe-7783-8933-26d8f3c47089` in `/tmp/ut-matrix/muse2/home` has the same completed record; this file records no approve step for the retry. The FAIL verdict stands, as recorded at the end of this file.

## Retry of step 2 (orchestrator, quiet checkout)

**Superseded 2026-11-13:** the statement below that no ultrathink hook event was observable is wrong. This retry's session log records the hook. See the correction above.

The earlier install failures ("held project plugin source inventory changed during snapshot") came while parallel matrix runs were writing into this checkout. Retried in a fresh isolated home (`/tmp/ut-matrix/muse2/home`) with no other writers: `muse plugins install . --scope user` exited 0 and reported `installed ultrathink 1.4.0 enabled=true trust=user-local`. Step 7 (prompt hook event) is unchanged from the run above: no ultrathink hook event was observable. Verdict stays FAIL.
