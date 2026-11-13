# Omp manual validation run

```
Host: Omp
Date (YYYY-MM-DD): 2026-11-13
Host version: omp/18.19.0 (`omp --version`; TUI banner v18.19.0)
Tester: MatrixOmp (agent)
Pass or fail: Pass
Notes: Run 1 (interactive) covered steps 1-10; every install, load, invoke, and uninstall step gave its documented result. Headless steps 6 and 7 were not run: no headless path reaches the slash commands (print and RPC modes exit 1 at the model gate). Open item: real-home ultrathink/last-skip.json rewritten at 04:33:38 and 04:39:06 UTC; writer not identified.
```

## Scope

- Runbook: `docs/validation/manual-matrix.md`, section `## Omp`. Install doc: `docs/install/omp.md`.
- Checkout: commit `d455baf`, branch `plugin-core-slice`.
- Run 1: interactive, steps 1-10 in order. Steps 5-7 used the TUI; steps 1-4 and 8-10 used the CLI.
- Run 2: after Main's stop instruction. Headless attempts for steps 6-7, then steps 8-10 again. Run 1 step 8 had already uninstalled the plugin, so Run 2 reinstalled it first (the step 3 command) so the headless attempts ran against an installed plugin.
- Matrix "Recorded result" cell: not edited (edits limited to this file).

## Isolation

- HOME: `/tmp/ut-matrix/omp/home`. Config: `PI_CODING_AGENT_DIR=/tmp/ut-matrix/omp/home/.omp/agent`.
- Every host command ran as `env -i HOME=/tmp/ut-matrix/omp/home PI_CODING_AGENT_DIR=/tmp/ut-matrix/omp/home/.omp/agent PATH="$PATH" LANG=C.UTF-8 <command>`. The TUI also set `TERM=xterm-256color`. `env -i` drops the parent session's `PI_SESSION_FILE`, `PI_SESSION_ID`, and `PI_TOOL_CALL_ID`.
- Baseline: `home/.omp/agent/` was empty before step 1.
- Pre-install list (Run 1 step 2) showed `No plugins installed`. The operator's live install (ultrathink@1.21.2, per the operator) was not shown.
- Omp reports its state path as `State: /tmp/ut-matrix/omp/home/.omp/agent/ultrathink` (Run 1 step 7 output below).
- Repo `git status --porcelain` before and after Run 1: only `?? .gsd-run/` and `?? docs/validation/results/`.
- Caveat: the first `omp --version` probe ran with HOME and PI_CODING_AGENT_DIR isolated but without `env -i`, so it inherited the parent's PI_* variables. It printed only the version.
- Harness: the TUI service log is kept by the harness under `/root/.omp/run/daemons/`, outside Omp's state.
- Real-home access: read-only only (`last-skip.json`, `control.json`, a dir listing, and mtime stats). No command was run against the real home.

## Run 1 (interactive)

### Pre-run: version

Command: `env HOME=/tmp/ut-matrix/omp/home PI_CODING_AGENT_DIR=/tmp/ut-matrix/omp/home/.omp/agent omp --version`. Exit 0.

```
omp/18.19.0
```

### Step 1: dry-run install

Command: `env -i <isolation> omp plugin install --dry-run .` (cwd: repo root). Exit 0.

```
[dry-run] Would link .
```

Result: matches the expected output. Nothing installed.

### Step 2: list before install

Command: `env -i <isolation> omp plugin list`. Exit 0.

```
No plugins installed

Install plugins with: omp plugin install <package>
```

Result: ultrathink not listed. Lifecycle `not_installed`.

### Step 3: install (default user scope)

Command: `env -i <isolation> omp plugin install .` (cwd: repo root; no `--scope` flag, so the default user scope). Exit 0.

```
✔ Linked ultrathink from .
```

### Step 4: list after install

Command: `env -i <isolation> omp plugin list`. Exit 0.

```
npm Plugins:

● ultrathink@1.4.0
```

Result: listed. Version 1.4.0 equals the checkout's `package.json` version.

### Step 5: restart, then /reload-plugins

- Fresh TUI process after the install: `env -i <isolation> TERM=xterm-256color omp` in a pty service, cwd repo root.
- The first launch in the empty isolated home showed first-run setup. Text rows only, banner art omitted:

```
Setup step 1 of 6
Sign in to your providers
Sign in to one or more providers. Press ⎋ when you're done.
Pick a provider to sign in — you can connect more than one.
╭─ Select provider to login ─...
│ Search: /reload-plugins
│ No matching providers
╰─...
↑/↓ select · ⏎ confirm · ⎋ skip · Ctrl+C exit setup
```

- Two real ESC bytes (`\x1b`) left that screen unchanged. Ctrl+C (`\x03`) exited setup to the main prompt. No provider was signed in and no credential was used.
- The main prompt then showed:

```
 Warning: No default model selected. Use /login, set an API key environment variable, or select a local model with
 /model or --model.
 Update Available
 New version 18.20.0 is available. Run: omp update
 ultrathink > idle > linear ⏳ notion ⏳ greptile ⏳ ▶
```

  `omp update` was not run.

- `/reload-plugins` typed and submitted. Output:

```
 Plugins reloaded.
```

Result: passes. Both the restart and the reload path were exercised.

### Step 6: registered commands (interactive)

Each command was typed at the main prompt, submitted with CR, and read from the pane. Output verbatim.

`/ultrathink-quick` (no text):

```
 Usage: /ultrathink-quick <message>. Sends the message to the agent as typed, without planning.
```

`/ultrathink-skip`:

```
 Prompt Uplift will skip the next prompt in this session
```

`/ultrathink-off`:

```
 Prompt Uplift off
```

`/ultrathink-on` (restores planning):

```
 Prompt Uplift on
```

`/ultrathink-track` (no argument):

```
 Tracking: on (not configured: set notion.dataSourceUrl / linear.team)
 Notion: not configured
 Linear team: not configured
```

`/ultrathink-ui` (no argument) opened the native dashboard overlay:

```
Ultrathink · Host: Omp | Project: repos | Session: 01a1d328-12b0-7099-97bb-61d04e7d0850 · Snapshot: 2026-11-13T04:33:31…
[Overview]  Jev  Moments  Skills
Host: Omp | Project: repos | Session: 01a1d328-12b0-7099-97bb-61d04e7d0850
Snapshot: 2026-11-13T04:33:31.737Z
No saved Jev decisions for this session
This view reads the latest saved plan, not a complete history. Refresh after a plan is saved; opening this view never
evaluates Jev.
Moments: candidate: 0 · confirmed: 0 · promoted: 0 · superseded: 0
Skills: 0 eligible · 0 promoted
Capture: auto · Recall: enabled (limit 5, 3000 chars) · Auto-promotion: enabled · Threshold: 3
Limitation: Teaching Jev history is not recorded. Lesson state is not a verdict receipt.
Limitation: Detached worker outcomes are not recorded. No completion or install result can be inferred.
Limitation: No saved Jev decisions for this session (no saved plan was found). This view reads the latest saved plan,
not a complete history.
> Open Jev details
  Open Moments
  Open Skills
  Refresh snapshot
Esc close dashboard · ←/→ choose action · Enter select action · Tab change focus
```

It was closed with the Kitty-protocol Escape (`\x1b[27u`). Plain ESC did not close it (see Notes).

`/ultrathink-swarm` (no argument) printed its usage box:

```
╭──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╮
│                                                                                                                      │
│ 📦 custom-message                                                                                                    │
│                                                                                                                      │
│ no lane briefs given. /ultrathink-swarm usage: /ultrathink-swarm <brief>|<brief>|… spawns one AgentSwarm             │
│ orchestrator lane per brief (up to 6 per command). Swarm drops briefs its classifier does not read as SDLC work, so  │
│ those are refused up front. /ultrathink-swarm status reports each lane as planning, running, skipped, plan-failed,   │
│ done, attention or not-planned; /ultrathink-swarm stop [laneId|all] ends a lane's process group. A lane's real       │
│ output is autonomous.log, events.jsonl and results/ in its state dir (<state dir>/swarm/<lane>/); run.log there is   │
│ only the wrapper's own stdout. ULTRATHINK_SWARM_MAX_LANES (default 3, cap 6) bounds live lanes across all commands,  │
│ and a brief already running in the same repository is refused; two lanes in one repository share one working tree    │
│ and its branches. Lanes are detached on purpose: ending the Omp session does not stop them. Configuration is         │
│ env-only: ULTRATHINK_SWARM_ROOT (or SWARM_ROOT) names the absolute agent-swarm checkout (required).                  │
│                                                                                                                      │
╰──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯
```

Result: all eight names responded. Lifecycle `loaded` is observable.

### Step 7: /ultrathink-status (interactive, after step 6)

Command: `/ultrathink-status` typed at the main prompt and submitted. Output verbatim (21 lines):

```
 Prompt Uplift on (skipping next prompt)
 Engine: omp-native:auto (live model not observed)
 Claude: claude-haiku-5-5 · auth plan · fallback to Grok off
 Grok: grok-build-0.1 · transport http
 SuperGrok OAuth: not logged in (run grok login)
 Graph of Thought on
 HITL clarifications on · max 4
 Tracking: on (not configured: set notion.dataSourceUrl / linear.team)
 Notion: not configured
 Linear team: not configured
 Substrate: off (optional: set substrate.url or SUBSTRATE_URL)
 Ship: off (opt-in: set ship.enabled)
 Knowledge base: off (opt-in: set hitl.knowledgeBase)
 Decisions: on · no Jev key (bin/ultrathink-mcp auth set-key openrouter --stdin or ULTRATHINK_OPENROUTER_KEY)
 Hindsight: off (opt-in: set hindsight.enabled)
 RAGFlow: off (opt-in: set ragflow.enabled)
 Teach: on · capture auto · recall on · 0 confirmed, 0 candidate · Hindsight off · outbox 0
 Stack: 2 off · 3 missing (run ultrathink stack)
 Engine request: auto (config) · concurrency 3
 State: /tmp/ut-matrix/omp/home/.omp/agent/ultrathink
```

Result: responds. Footer `ultrathink > idle`. The first line carries `(skipping next prompt)` because of step 6's `/ultrathink-skip`. An earlier status run, before any step 6 command, read ` Prompt Uplift on`; its other lines were identical.

### Step 8: uninstall (Run 1)

- Before: the TUI was exited with Ctrl+D (exit code 0).
- `env -i <isolation> omp plugin uninstall ultrathink --dry-run`. Exit 0.

```
[dry-run] Would uninstall ultrathink
```

- `env -i <isolation> omp plugin uninstall ultrathink`. Exit 0.

```
✔ Uninstalled ultrathink
```

### Step 9: list after uninstall (Run 1)

Command: `env -i <isolation> omp plugin list`. Exit 0.

```
No plugins installed

Install plugins with: omp plugin install <package>
```

Result: ultrathink gone. Registry after uninstall: `plugins/omp-plugins.lock.json` = `{"plugins": {}, "settings": {}}`; `plugins/package.json` = `{"name": "omp-plugins", "private": true, "dependencies": {}}`; `plugins/node_modules/` empty.

### Step 10: delete the state dir by hand (Run 1)

- Before deletion, `agent/ultrathink/` held `control.json` (21 B, mode 600) and `sessions/` (mode 700). It had no `last-skip.json`. Uninstall left the dir, as the install doc says.
- `rm -rf -- /tmp/ut-matrix/omp/home/.omp/agent/ultrathink`. Exit 0. Check: absent.
- Remaining in `agent/`: `cache/`, `predict/`, `sessions/`, `terminal-sessions/`, `agent.db`, `config.yml`, `history.db`, `last-changelog-version`, `models.db`, `skill-descriptions.db`.

## Run 2 (after stop instruction)

### Pre-check: list before reinstall

Command: `env -i <isolation> omp plugin list`. Exit 0.

```
No plugins installed

Install plugins with: omp plugin install <package>
```

### Help discovery

Command: `env -i <isolation> omp --help`. Exit 0. Relevant lines (the tool truncated the rest):

```
  -p, --print                           Non-interactive mode: process prompt and exit
      --mode=<value>                    Output mode: text (default), json, rpc, or rpc-ui
```

### Reinstall (repeat of step 3)

- `env -i <isolation> omp plugin install .`. Exit 0.

```
✔ Linked ultrathink from .
```

- `env -i <isolation> omp plugin list`. Exit 0.

```
npm Plugins:

● ultrathink@1.4.0
```

### Headless attempts: step 7

1. `env -i <isolation> omp -p "/ultrathink-status"`. Exit 1.

```
No default model selected. Use /login, set an API key environment variable, or select a local model with /model or --model.

Set an API key environment variable:
  ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, etc.

Or create /tmp/ut-matrix/omp/home/.omp/agent/models.yml
```

2. `printf '%s\n' '{"type":"get_state"}' '{"type":"prompt","message":"/ultrathink-status"}' | env -i <isolation> omp --mode rpc`. Exit 1. Same text as attempt 1.

Result: **not run: no headless path.** Print and RPC modes both stop at the model gate before the slash command runs. No placeholder API key was used; that would work around the gate.

### Headless attempts: step 6

- `env -i <isolation> omp -p "/ultrathink-quick"`. Exit 1. Same text as above.
- `env -i <isolation> omp -p "/ultrathink-track"`. Exit 1. Same text as above.

Result: **not run: TUI not drivable headless.** Only quick and track were attempted headless. Skip, off, on, and ui were not re-run headless, to avoid state churn. The interactive results in Run 1 step 6 stand.

### Step 8 (Run 2)

- `env -i <isolation> omp plugin uninstall ultrathink --dry-run`. Exit 0.

```
[dry-run] Would uninstall ultrathink
```

- `env -i <isolation> omp plugin uninstall ultrathink`. Exit 0.

```
✔ Uninstalled ultrathink
```

### Step 9 (Run 2)

Command: `env -i <isolation> omp plugin list`. Exit 0.

```
No plugins installed

Install plugins with: omp plugin install <package>
```

### Step 10 (Run 2)

- `ls -la /tmp/ut-matrix/omp/home/.omp/agent/ultrathink`. Exit 2.

```
/usr/bin/ls: cannot access '/tmp/ut-matrix/omp/home/.omp/agent/ultrathink': No such file or directory
```

- `rm -rf -- /tmp/ut-matrix/omp/home/.omp/agent/ultrathink`. Exit 0. Check: absent.

### Final read-only checks (after Run 2 steps 8-10)

- Isolated `plugins/omp-plugins.lock.json` = `{"plugins": {}, "settings": {}}`.
- Real home: `control.json` mtime `2026-11-10 12:13:14` (unchanged across the run). `last-skip.json` mtime `2026-11-13 04:39:06.665827674`, content `{"reason": "skip-once", "at": 1794544746666}`.
- Repo `git status --porcelain`: unchanged (`?? .gsd-run/`, `?? docs/validation/results/`).

## Lifecycle states

Install:
- `not_installed`: observable (Run 1 step 2; Run 2 pre-check).
- `installing`: not observable on this host.
- `installed`: observable (Run 1 step 4 `● ultrathink@1.4.0`; Run 2 re-list).
- `install_failed`: not observed. Both installs exited 0 and were listed.

Load:
- `loading`: not observable on this host.
- `loaded`: observable interactively (Run 1 step 5 reload, then all eight commands responded; footer `ultrathink > idle`). Headless: not reachable, because the model gate runs first.
- `version_mismatch`: not observable on this host.
- `capability_missing`: not observable on this host.
- `load_failed`: not observed in the interactive run. Headless: not reachable.

Invoke:
- `idle`: observable (`/ultrathink-status` responds; footer `ultrathink > idle`).
- `running`: not observable on this host.
- `awaiting_user_decision`: not observable on this host. The dashboard shows "No saved Jev decisions for this session" with no awaiting-state display.
- `succeeded`: not observable on this host.
- `failed`: not observable on this host. The headless `No default model selected` exit 1 is the host's model gate, not a plugin invoke result.
- `cancelled`: not observable on this host.

## Notes

1. Typed input (not runbook steps): an incomplete `/ultrathink-` typed at the prompt showed `Usage: /ultrathink-quick ...` and `Error: No model selected.`, and the text did not remain in the prompt. `/help` produced no output and stayed in the prompt after Enter and CR.
2. Escape: plain ESC did not close the dashboard. `ESC [ 27 u` did. A following DEL byte moved the dashboard to the Jev tab without closing it.
3. Ctrl+C did not exit the main session (two presses). Ctrl+D exited with code 0.
4. `/ultrathink-skip` leaves a one-shot skip armed. No verb in the command set clears it. The step 7 status showed it armed.
5. The "Update Available: New version 18.20.0 ... Run: omp update" banner was observed and not acted on.
6. The repo's `.omp/config.yml` lists an extra extension, `/root/src/repos/agent-swarm/omp`. The TUI ran from the repo root, so that project config applied. Not investigated.
7. Versions: the isolated install reports `ultrathink@1.4.0`, matching the checkout's `package.json`. The operator reports 1.21.2 on the live install; not compared here.

## Unverified items hit

- Minimum Omp version: not documented; not tested.
- Marketplace install: not exercised.
- Uninstall's effect on the state dir: observed kept (`control.json`, `sessions/`), then removed by hand in step 10.
- Uninstall leaves the `${PI_CODING_AGENT_DIR}/plugins/` registry emptied (`"plugins": {}`). Not documented.
- Command list: now confirmed live in the interactive run. Previously source-derived.

## Blockers

- Headless steps 6 and 7: blocked by login/model. Verbatim error above (`No default model selected`, exit 1), in print and RPC modes.
- Interactive first run: the setup wizard asks for a provider sign-in. Skipped with Ctrl+C. No credential was used.

## Open item (not attributed)

- `/root/.omp/agent/ultrathink/last-skip.json` (real home) was written with `{"reason": "skip-once", "at": 1794544418265}` at 04:33:38 UTC, then rewritten with `{"reason": "skip-once", "at": 1794544746666}` at 04:39:06 UTC. Both fall inside this run.
- No command was run against the real home. The isolated `ultrathink/` dir had no `last-skip.json` when listed before Run 1 step 10, and it did not exist during Run 2. Nothing links these writes to the isolated runs.
- The real `control.json` mtime stayed `2026-11-10 12:13:14` across the run.
- [INFERENCE] The writer is probably another live omp session on this machine that consumed a skip-once flag. The session running this agent is one candidate. Not identified. The operator should check.
