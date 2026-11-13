# Manual validation matrix

Manual runbook for the six host installs in `docs/install/`. Conformance subjects check declared commands on disk only and do not run hosts. This runbook covers the host-side steps they cannot.

## Rules

- Run only the commands listed here. Each comes from `docs/install/<host>.md`. Do not substitute commands.
- A state marked **not observable on this host** has no surface in that host's install doc that displays it. Record "not observable" rather than inferring it.
- UNVERIFIED items in the install docs stay unverified. If a step depends on one, record the blocker in Notes.
- Pass: every install, load, invoke, and uninstall step gives its documented result. Fail: any step does not.
- Fill only the Recorded result column of the matrix and the results template.

## Matrix

| Host | Install | Load | Invoke a command | Uninstall | Recorded result |
|---|---|---|---|---|---|
| Omp | `omp plugin install .` from repo root; check with `omp plugin list` | `/reload-plugins` or restart Omp | `/ultrathink-status` | `omp plugin uninstall ultrathink` | |
| Hermes | Per-file install from `docs/install/hermes.md`: link each file of `hosts/hermes` into a real `~/.hermes/plugins/ultrathink`, not the directory; `hermes plugins enable ultrathink` | Enable notifies gateway; restart if reported required | `/ultrathink-lessons` | `hermes plugins disable ultrathink`; `hermes plugins remove ultrathink` | |
| Prime Agent | `prime-agent package install <source> [--local]` (source syntax UNVERIFIED) | Fresh session; `/skill:ultrathink` | `/ultrathink-status` | `prime-agent package remove <source> [--local]` | |
| Claude Code | `claude plugin marketplace add swcstudiospace/claude-ultrathink`; `claude plugin install ultrathink@ultrathink --scope user` | `/reload-plugins` or new session | Submit a prompt; the UserPromptSubmit hook plans it | `claude plugin uninstall ultrathink` | |
| Grok Build | `grok plugin install <path-to-checkout>`; answer the trust prompt | `/plugins`, press `r` in Plugins tab, or new session | Submit a prompt; the UserPromptSubmit hook plans it | `grok plugin uninstall ultrathink` | |
| Muse Code | `muse plugins install . --scope user`; `muse plugins approve ultrathink` | New session | Submit a prompt; the UserPromptSubmit hook plans it | `muse plugins remove ultrathink` | |

---

## Omp

Observed host: `omp/18.19.0`. Minimum version: not documented. Source: `docs/install/omp.md`.

### Steps

1. From the repo root, run `omp plugin install --dry-run .`. Expect `[dry-run] Would link .` and no install.
2. Run `omp plugin list`. Record whether ultrathink is listed.
3. Run `omp plugin install .`. Add `--scope project` for project scope; the default is `user`.
4. Run `omp plugin list`. Confirm ultrathink is listed.
5. In Omp, run `/reload-plugins`, or restart Omp.
6. Confirm these commands are registered: `/ultrathink-quick`, `/ultrathink-skip`, `/ultrathink-off`, `/ultrathink-on`, `/ultrathink-track`, `/ultrathink-status`, `/ultrathink-ui`, `/ultrathink-swarm`. The doc derived this list from source, not a live session.
7. Run `/ultrathink-status`. Record its output verbatim.
8. Optional: run `omp plugin uninstall ultrathink --dry-run` to preview. Then run `omp plugin uninstall ultrathink`.
9. Run `omp plugin list`. Confirm ultrathink is gone.
10. Delete `${PI_CODING_AGENT_DIR:-~/.omp/agent}/ultrathink` by hand. The doc says uninstall does not remove it.

### Lifecycle states to observe

Install
- `not_installed`: observable. Step 2 does not list ultrathink.
- `installing`: not observable on this host. The install is one synchronous command with no documented progress output.
- `installed`: observable. Step 4 lists ultrathink.
- `install_failed`: observable. Step 3 exits non-zero, or step 4 does not list ultrathink. The error text is undocumented; record it verbatim.

Load
- `loading`: not observable on this host.
- `loaded`: observable. After step 5, the commands in step 6 respond.
- `version_mismatch`: not observable on this host. No version check is documented.
- `capability_missing`: not observable on this host. The manifest declares no permissions.
- `load_failed`: not observable on this host. No load error surface is documented. Record missing commands in Notes.

Invoke
- `idle`: observable. `/ultrathink-status` responds. Its output format is undocumented.
- `running`: not observable on this host.
- `awaiting_user_decision`: not observable on this host. The source defines a dashboard, but no documented state display.
- `succeeded`: not observable on this host.
- `failed`: not observable on this host.
- `cancelled`: not observable on this host.

---

## Hermes

Observed host: Hermes Agent v0.23.1 (2026.9.24). Minimum version: not documented. Python 3.10 or later. Source: `docs/install/hermes.md`.

### Steps

1. From the repo root, run `hermes plugins list --plain`. Record whether ultrathink is listed.
2. Run the install block in `docs/install/hermes.md` (`## Install`), except its last line, `hermes plugins enable ultrathink`, which is step 4. It makes `~/.hermes/plugins/ultrathink` a real directory and links each file of `hosts/hermes` into it. Do not link the directory, and do not copy the files.
3. Run `ls -l ~/.hermes/plugins/ultrathink`. Each file should be a link into `hosts/hermes`, not a copy; a copy breaks `REPO_ROOT` and the skill paths.
4. Run `hermes plugins enable ultrathink`.
5. Run `hermes plugins validate hosts/hermes`. Expect a pass with one warning about the private core import at `bridge.py:153`.
6. Run `hermes plugins list --plain`. Confirm ultrathink is listed as enabled.
7. If Hermes reports that a restart is required, restart the gateway or session. If no gateway responded, Hermes says so.
8. Run `/ultrathink-lessons`. Record the returned text verbatim.
9. Run `hermes plugins disable ultrathink`.
10. Run `hermes plugins remove ultrathink`.
11. Run `ls -l ~/.hermes/plugins/ultrathink`. If the directory remains, run `rm -r ~/.hermes/plugins/ultrathink`. It deletes only links, so the repository is untouched.
12. Plugin data directories are kept on remove. Record whether one exists.

### Lifecycle states to observe

Install
- `not_installed`: observable. Step 1 does not show ultrathink enabled, and step 2 has not run.
- `installing`: not observable on this host. Installation is a set of file links plus a CLI call with no documented progress output.
- `installed`: observable. Step 6 lists ultrathink as enabled.
- `install_failed`: observable. Step 5 fails, or step 3 shows a `hosts/hermes` file missing from `~/.hermes/plugins/ultrathink`.

Load
- `loading`: not observable on this host.
- `loaded`: observable. Step 6 shows enabled and step 7 reports no restart needed.
- `version_mismatch`: not observable on this host. No Hermes minimum is documented.
- `capability_missing`: not observable on this host. The manifest declares no `requires_env` or `capabilities`.
- `load_failed`: not observable on this host. The only documented signal is "restart required", which means no gateway answered, not that load failed.

Invoke
- `idle`: observable. `/ultrathink-lessons` returns text.
- `running`: not observable on this host.
- `awaiting_user_decision`: not observable on this host.
- `succeeded`: not observable on this host.
- `failed`: not observable on this host.
- `cancelled`: not observable on this host.

---

## Prime Agent

Observed host: Prime Agent 0.10.2. Minimum version: not documented. Source: `docs/install/prime-agent.md`.

### Steps

1. Run `prime-agent package list`. Record whether the package is listed.
2. Run `prime-agent package install <source> [--local]`. The source syntax is UNVERIFIED for 0.10.2. The install doc gives no value. Do not guess one. If the source form is unknown, stop and record the blocker in Notes.
3. Run `prime-agent package list`. Confirm the package is listed.
4. Start a fresh session. Skills load at startup.
5. In the fresh session, run `/skill:ultrathink`. Confirm the entry loads.
6. Run `/ultrathink-status`. Record the reply. It should report planner state without planning. The control table maps this command to the skill, so it works only while the agent follows the skill.
7. Run `prime-agent package remove <source> [--local]`. Use the same `--local` choice as step 2.
8. Run `prime-agent package list`. Confirm the package is gone.
9. Record whether `${PRIME_AGENT_CODING_AGENT_DIR:-~/.prime/agent}/ultrathink/` remains. The doc does not document removal.

### Lifecycle states to observe

Install
- `not_installed`: observable. Step 1 does not list the package.
- `installing`: not observable on this host. No progress output is documented.
- `installed`: observable. Step 3 lists the package.
- `install_failed`: observable. Step 2 exits non-zero, or step 3 does not list the package.

Load
- `loading`: not observable on this host.
- `loaded`: observable. Step 5 loads the entry in a fresh session.
- `version_mismatch`: not observable on this host. No version check is documented.
- `capability_missing`: not observable on this host. No capability concept is documented.
- `load_failed`: not observable on this host. A skill with an empty description is silently not loaded.

Invoke
- `idle`: observable. Step 6 replies to `/ultrathink-status`.
- `running`: not observable on this host.
- `awaiting_user_decision`: not observable on this host.
- `succeeded`: not observable on this host.
- `failed`: not observable on this host.
- `cancelled`: not observable on this host.

---

## Claude Code

Observed host: Claude Code 2.1.322. Minimum version: no base version documented; `--marketplace` needs 2.1.275, shell install needs 2.1.292. Bun is required; without it hooks exit 0 and the CLIs exit 127. Source: `docs/install/claude-code.md`.

### Steps

1. Run `claude plugin list`. Record whether ultrathink is listed.
2. Run `claude plugin marketplace add swcstudiospace/claude-ultrathink`.
3. Run `claude plugin install ultrathink@ultrathink --scope user`. Scope may be `user`, `project`, or `local`. The equivalent single command is `claude plugin install ultrathink --marketplace swcstudiospace/claude-ultrathink --scope user`.
4. Run `claude plugin list`. Confirm ultrathink is listed.
5. Run `/reload-plugins` in a session, and also start a new session. The docs conflict on which is needed, so do both.
6. Submit any prompt. The UserPromptSubmit hook (`hooks/uplift.ts`) plans it.
7. Run `claude plugin uninstall ultrathink`.
8. Run `claude plugin list`. Confirm ultrathink is gone.
9. Record whether `~/.claude/plugins/data/<id>/` remains. The doc says removing the last scope deletes it, except for exceptions listed in the CLI reference.

### Lifecycle states to observe

Install
- `not_installed`: observable. Step 1 does not list ultrathink.
- `installing`: not observable on this host. Install is one CLI call with no documented progress output.
- `installed`: observable. Step 4 lists ultrathink.
- `install_failed`: observable. Step 3 exits non-zero, or step 4 does not list ultrathink.

Load
- `loading`: not observable on this host.
- `loaded`: observable only indirectly. Step 5 completes and the plugin is listed. The doc does not define what `claude plugin list` shows for loaded versus installed; record its output verbatim.
- `version_mismatch`: not observable on this host. No version check is documented.
- `capability_missing`: not observable on this host. The manifest declares no `userConfig`.
- `load_failed`: not observable on this host. `claude plugin validate .` is a maintainer manifest check, not a load test.

Invoke
- `idle`: not observable on this host. No documented command shows idle state.
- `running`: not observable on this host.
- `awaiting_user_decision`: observable. The PostToolUse hook on `AskUserQuestion` (`hooks/answers.ts`) folds the answer in. Trigger it only if the session asks a question.
- `succeeded`: not observable on this host.
- `failed`: not observable on this host.
- `cancelled`: not observable on this host.

---

## Grok Build

Observed host: Grok Build 1.0.77. Minimum version: not documented. Bun 1.2 or later. Source: `docs/install/grok-build.md`.

### Steps

1. Run `grok plugin list`. Record whether ultrathink is listed. Whether a local-path install appears here is unverified.
2. From the repo root, run `grok plugin install <path-to-checkout>`. Add `--trust` only for a checkout you trust. Without it, Grok asks first. Skills, hooks, and MCP servers stay inactive until the plugin is trusted.
3. Run `grok plugin list`. Record the result.
4. Run `grok plugin details ultrathink`. Check for skills, commands, and hooks. The output format is undocumented; record it verbatim.
5. Open `/plugins` and press `r` in the Plugins tab, or start a new session.
6. Submit any prompt. The UserPromptSubmit hook (`uplift.ts`) plans it. Confirm the plugin is trusted first.
7. Optional: run `grok plugin disable ultrathink` to check that disable works, then `grok plugin enable ultrathink` to re-enable.
8. Run `grok plugin uninstall ultrathink`. Add `--keep-data` to preserve the data directory. The default removes it, inferred from help text.
9. Run `grok plugin list`. Confirm ultrathink is gone.

### Lifecycle states to observe

Install
- `not_installed`: observable with a caveat. Step 1 does not list ultrathink. Local-path visibility is unverified.
- `installing`: not observable on this host. No progress output is documented.
- `installed`: observable. Step 4 shows the component inventory. Record the trust state from step 2.
- `install_failed`: observable. Step 2 exits non-zero, or step 4 shows no components.

Load
- `loading`: not observable on this host.
- `loaded`: observable. Step 4 shows components after step 5 reloads.
- `version_mismatch`: not observable on this host. No version check is documented.
- `capability_missing`: not observable on this host. The repo declares no MCP servers or `allowed-tools`.
- `load_failed`: not observable on this host. No load error surface is documented.

Invoke
- `idle`: not observable on this host.
- `running`: not observable on this host.
- `awaiting_user_decision`: not observable on this host. The `AskUserQuestion` matcher is unverified on Grok.
- `succeeded`: not observable on this host.
- `failed`: not observable on this host.
- `cancelled`: not observable on this host.

---

## Muse Code

Observed host: Muse Code 1.4.14. Local channel reports 1.4.15 as latest. Minimum version: not documented. Source: `docs/install/muse.md`.

### Steps

1. Run `muse plugins list`. Record whether ultrathink is listed.
2. From the repo root, run `muse plugins install . --scope user`. The doc does not state a default scope, so record the one you use.
3. Run `muse plugins approve ultrathink`. Whether `install` alone enables the runtime capabilities is unverified, so run this step.
4. Run `muse plugins list`. Confirm ultrathink is listed.
5. Run `muse plugins inspect ultrathink`. Record the output verbatim.
6. Start a new session. Muse loads hook changes then.
7. Submit any prompt. The UserPromptSubmit hook (`hooks/muse-prompt`, timeout 600000 ms) plans it.
8. Run `muse plugins remove ultrathink`. Add `--delete-data` only if you intend to; its effect is not documented. Record whether it was used.
9. Run `muse plugins list`. Confirm ultrathink is gone.

Experimental gate: the doc records an unverified claim that plugin commands need `MUSE_EXPERIMENTAL_PLUGINS=1`. Install and approve were not tested with or without it. If step 2 or 3 fails, repeat with and without the variable and record both results.

### Lifecycle states to observe

Install
- `not_installed`: observable. Step 1 does not list ultrathink.
- `installing`: not observable on this host. No progress output is documented.
- `installed`: observable. Steps 4 and 5 list and inspect ultrathink.
- `install_failed`: observable. Step 2 or 3 exits non-zero, or step 4 does not list ultrathink.

Load
- `loading`: not observable on this host.
- `loaded`: observable only indirectly. Step 5 after step 6 shows the plugin. The doc does not define the inspect output for loaded versus installed; record it verbatim.
- `version_mismatch`: not observable on this host. No version check is documented.
- `capability_missing`: not observable on this host. The validator counts only skills, commands, hooks, mcp, and reminders.
- `load_failed`: not observable on this host. No load error surface is documented.

Invoke
- `idle`: not observable on this host. The install doc names no command that displays it.
- `running`: not observable on this host.
- `awaiting_user_decision`: not observable on this host.
- `succeeded`: not observable on this host.
- `failed`: not observable on this host.
- `cancelled`: not observable on this host.

---

## Results template

Copy one block per host run and paste it into the run record.

```
Host:
Date (YYYY-MM-DD):
Host version: (as reported by the host; the install docs give `omp --version` and `grok --version` only)
Tester:
Pass or fail:
Notes: (observed states, states not observable, unverified items hit, verbatim errors)
```
