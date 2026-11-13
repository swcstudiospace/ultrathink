# Hermes manual validation run

Host: Hermes
Date (YYYY-MM-DD): 2026-11-13
Host version: `hermes --version` → `Hermes Agent v0.23.1 (2026.9.24) · stable · local 3b4215785882`. Install method: git. Python 3.14.9.
Tester: MatrixHermes (delegated worker agent)
Checkout: `/root/src/repos/claude-ultrathink`, branch `plugin-core-slice`, commit `d455baf`.
Pass or fail: **FAIL** (step 10 `hermes plugins remove ultrathink` exits 1 for a symlinked plugin; see Step 10).

## Isolation

Root: `/tmp/ut-matrix/hermes/`. Every host command ran with `HOME=/tmp/ut-matrix/hermes/home` and `HERMES_HOME=/tmp/ut-matrix/hermes/home/.hermes`. Helper wrapper: `/tmp/ut-matrix/hermes/hx.sh` (`env -i PATH TERM LANG HOME HERMES_HOME`, then `hermes "$@"`). Step 1 and its first list runs used `/tmp/ut-matrix/hermes/env.sh` (exports HOME/HERMES_HOME only, inherits everything else); see Isolation incident for why later runs used the scrubbed wrapper.

Isolation check (rule 2): the step 1 `hermes plugins list --plain` run under the isolated home listed only `bundled` entries (63 lines, zero `user` entries, no ultrathink). The operator's real install (`/root/.hermes/plugins/ultrathink`, a symlink dated Oct 19) was not listed and was not touched. The only access to the real home was one read-only `ls -ld` check in Step 11 and one read-only `grep` of the real `/root/.hermes/logs/gateway.log` for Telegram 409 conflicts (none found). Isolation was honored for every mutating command.

Isolation incident (not in the runbook, recorded per rules):
- The first `hermes chat -q '/ultrathink-lessons' --oneshot` ran with the inherited shell environment, which contains `TELEGRAM_BOT_TOKEN`, `TELEGRAM_HERMES_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, and others. Hermes auto-started a gateway under the isolated `HERMES_HOME` (`gateway.log`: `Connecting to telegram...` at 04:25:42, `Telegram polling confirmed healthy: getUpdates progressing` at 04:25:54). That gateway polled Telegram with an inherited bot token until I stopped it with SIGTERM at 04:26:29 (`Gateway stopped by an unexpected signal`). The real gateway log shows no HTTP 409 in 04:25-04:27. Credentials were inherited from the environment, not copied into the isolated home.
- A second auto-started isolated gateway (`gateway run --quiet --idle-exit`) ran during the interactive session in Step 8 and during Step 9. Both were stopped; the final check found no isolated gateway running.
- Credential handling: no real credentials were copied into the isolated home. Later runs used `env -i`, so no messaging or LLM keys were inherited. The isolated `config.yaml` has `model.provider=custom`, `model.base_url=http://127.0.0.1:9/v1`, `model.default=ut-matrix-placeholder` (set by me in Step 8 prep, see below). No provider key exists under the isolated home, and no model call succeeded.

## Steps

### Step 1: `hermes plugins list --plain`
Exit 0. Ultrathink not listed. Output is 63 lines; truncated (over 60 lines). Head, then tail, then the grep result:
```
enabled      bundled  1.0.0    browser-browser-use
enabled      bundled  1.0.0    browser-browserbase
enabled      bundled  1.0.0    browser-firecrawl
not enabled  bundled  1.0.0    chronos
enabled      bundled  1.0.0    basic
... [35 lines omitted: bundled platform, provider, and web plugin rows] ...
enabled      bundled  1.0.0    web-tavily
enabled      bundled  1.0.0    web-xai
```
`grep -i "ultrathink|omp-|code-review|github|greptile|polyglot|substrate"` → no match, exit 1. Lifecycle: `not_installed` observable.

Note: the first run of this step (`hermes plugins list --plain`, first call) printed a dependency-preparation log before the list (venv staging under the isolated home: "Preparing the isolated Hermes runtime…", "Installed 4 packages"). That log is host bootstrap output, not an error.

### Step 2: `mkdir -p ~/.hermes/plugins`
Exit 0. `ls -l ~/.hermes/plugins/` after the link was created showed the `ultrathink` symlink (see Step 3).

### Step 3: `ln -s "$PWD/hosts/hermes" ~/.hermes/plugins/ultrathink`
Exit 0. Verified:
```
lrwxrwxrwx 1 root root 46 Nov 13 04:24 /tmp/ut-matrix/hermes/home/.hermes/plugins/ultrathink -> /root/src/repos/claude-ultrathink/hosts/hermes
```
`readlink -f` → `/root/src/repos/claude-ultrathink/hosts/hermes`. Lifecycle: `install_failed` not observed (link present).

### Step 4: `hermes plugins enable ultrathink`
Exit 0.
```
✓ Plugin ultrathink enabled.
```
No restart message was printed. Lifecycle: `loaded` observable (enabled; step 7 needs no restart per this output).

### Step 5: `hermes plugins validate hosts/hermes`
Exit 0. Passed with one warning.
```
✓ manifest — plugin.yaml parses
✓ manifest fields — name, version, description present
✓ requires_hermes — not declared
✓ config schema — not declared
✓ requires_env — all entries UPPER_SNAKE
✓ oauth — not declared
✓ loadable — entry: __init__.py
✓ python dependencies — none declared
✓ capability probe — register() ran in isolation
✓ declared tools — matches registrations
✓ declared hooks — matches registrations
✓ declared middleware — matches registrations
✓ built-in tool collisions — no collisions
✓ security scan — safe
✓ no core override — no runtime rebinds of Hermes core
⚠ private core imports (catalog rule 9: public surfaces only; these can break on
any release): bridge.py:156 hermes_cli.plugins. Use ctx.* / documented plugin 
APIs, or open an issue for the seam you need.
◆ Isolation — runs in the plugin host (plugins.isolation: host)

Validation passed.
```
Discrepancy: the runbook expects `bridge.py:153`; Hermes reports `bridge.py:156`. The current file has `from hermes_cli import plugins as hermes_plugins` at line 156 (grep). Recorded as is; the warning is the same import.

Side effect: validate imported `hosts/hermes/__init__.py` for the capability probe, creating `hosts/hermes/__pycache__/` (timestamp 04:25:01). It is gitignored (`.gitignore:11`) and `git status` does not show it. Not removed; flagged for the operator.

### Step 6: `hermes plugins list --plain`
Exit 0. Ultrathink listed as enabled. Output is 64 lines; truncated (over 60). Tail shown:
```
enabled      bundled  1.0.0    web-searxng
enabled      bundled  1.0.0    web-tavily
enabled      bundled  1.0.0    web-xai
enabled      user     1.4.0    ultrathink
```
Lifecycle: `installed` observable (`enabled user 1.4.0 ultrathink`).

### Step 7: Restart if reported required
Step 4 and step 6 output report no restart requirement. No gateway restart performed. Lifecycle: `loaded` observable.

Side note: the isolated gateway running at this time was started by my own earlier command under the isolated home, so no operator gateway was involved.

### Step 8: `/ultrathink-lessons`
Two attempts, both recorded.

(a) Headless, exit 1, rejected. `hermes chat -q '/ultrathink-lessons' --oneshot` treats the slash text as a model query:
```
Query: /ultrathink-lessons
Hermes couldn't start the model connection: storage_unavailable. Your message 
was not sent. Run `hermes doctor` to check the setup, or /model to pick a 
different provider.
```
A scrubbed-env retry (`hx.sh chat -q …`, no keys) exited 1 with `It looks like Hermes isn't configured yet -- no API keys or providers found. ... Run: hermes setup`. Headless one-shot did not route the slash command.

(b) Interactive, via a pseudo-terminal (`script -qfc "hx.sh chat"`). Initial run stopped at the first-run setup prompt (`Run setup now? [Y/n]`, no provider). I then ran, in the isolated home only:
```
hermes config set model.provider custom                  → EXIT 0
hermes config set model.base_url http://127.0.0.1:9/v1   → EXIT 0
hermes config set model.default ut-matrix-placeholder    → EXIT 0
```
This is config, not credentials. The placeholder endpoint is unreachable, so no model call can succeed. The next run hit a telemetry prompt first; my keystrokes were consumed there, so I answered `2` (No thanks; `✓ Shared metrics off.`). Final interactive run (`/tmp/ut-matrix/hermes/step8-pty3.log`, ANSI stripped, banner removed):
```
Help improve Hermes?
  Select by number, Enter to confirm.
  (○)  1. Share with Nous
  (●)  2. No thanks
  Choice [default 2]: 2
✓ Shared metrics off. Change it any time with `hermes setup telemetry`.
...
❯ /ultrathink-lessons
⚙️  /ultrathink-lessons
No lessons saved yet.
...
❯ /quit
Goodbye! ☤
```
Returned text, verbatim: `No lessons saved yet.` Exit 0 for the pty session. The pty input line showed a placeholder ("Draft a reply to the last email in my inbox") as the prompt's hint, not a submitted message, and no model call was made. Lifecycle: `idle` observable.

Not run in the `-q` form. Runbook rule 5 says record "not run: interactive only" when a host cannot run a prompt headless. Here the slash command was not routed headless, so the pty session is the step-8 evidence.

### Step 9: `hermes plugins disable ultrathink`
Exit 0.
```
⊘ Plugin ultrathink disabled.
The running gateway reloaded its plugins and unloaded ultrathink; platform hooks
it already wired up stay until a gateway restart (hermes gateway restart).
```
`plugins list --plain` after: `disabled     user     1.4.0    ultrathink`. Platform hooks remain until a gateway restart, per the output. Not restarted (no operator gateway touched; the isolated gateway was stopped after step 11).

### Step 10: `hermes plugins remove ultrathink`
**Exit 1. FAIL.**
```
Error: Invalid plugin name 'ultrathink': resolves outside the plugins directory.
```
Cause (observed): the plugin entry is a symlink to `hosts/hermes`, which resolves outside `~/.hermes/plugins/`. Hermes rejects it, so remove does not run. Install doc step (`hermes plugins remove ultrathink  # remove the plugin`) does not hold for the symlink install in this runbook. Post-failure `plugins list --plain` still showed `disabled user 1.4.0 ultrathink`. Lifecycle state for remove: not in the runbook's table; recorded as "remove failed, entry remains (disabled)".

### Step 11: `ls -l ~/.hermes/plugins/ultrathink`, then `rm` if the link remains
`ls -l` after step 10: link still present (`lrwxrwxrwx … ultrathink -> /root/src/repos/claude-ultrathink/hosts/hermes`, exit 0). The runbook then requires `rm`:
```
$ rm ~/.hermes/plugins/ultrathink   → EXIT 0
$ ls -l ~/.hermes/plugins/ultrathink → cannot access (No such file or directory), exit 2
```
Repository untouched by the rm (a symlink removal). `git status --short` afterward showed only pre-existing untracked entries (`.gsd-run/`, `docs/validation/results/`).

Post-remove plugin list (`hermes plugins list --plain`, isolated, `grep -i ultrathink`): no match, exit 1. Saved to `/tmp/ut-matrix/hermes/final-list.txt` (63 lines, all `bundled`, zero `user` entries).

### Step 12: plugin data directory
Hermes' data dir for ultrathink resolves to `$HERMES_HOME/ultrathink` (`bridge.py` `state_dir()`, around lines 476-490). Checked under the isolated home: `ls -la /tmp/ut-matrix/hermes/home/.hermes/ultrathink` → `No such file or directory`. `find … -maxdepth 2 -iname "*ultrathink*"` returned nothing after removal. No plugin data directory existed, so the "kept on remove" claim is not confirmed by this run. Lifecycle: no data directory created by install, enable, or `/ultrathink-lessons`.

## Lifecycle states

| State | Observed? | Evidence |
|---|---|---|
| not_installed | observable | Step 1: no ultrathink entry; grep exit 1 |
| installing | not observable | symlink plus CLI call, no progress output |
| installed | observable | Step 6: `enabled user 1.4.0 ultrathink` |
| install_failed | not observed | Step 5 passed; link present in Step 3 |
| loading | not observable | no progress output |
| loaded | observable | Step 4 enabled; no restart message |
| version_mismatch | not observable | no Hermes minimum documented |
| capability_missing | not observable | manifest declares no requires_env or capabilities |
| load_failed | not observable | only signal is restart-required, not seen |
| idle | observable | Step 8: `No lessons saved yet.` |
| running | not observable | - |
| awaiting_user_decision | not observable | - |
| succeeded | not observable | - |
| failed | not observable | - |
| cancelled | not observable | - |
| remove (not in runbook table) | blocked | Step 10 exit 1, `resolves outside the plugins directory` |

## Unverified items hit
- Install doc: "`hermes plugins remove` removes the plugin" fails for a symlinked install (Step 10). The Hermes CLI validates plugin names against the plugins directory and rejects symlinks that resolve outside it.
- Runbook step 5 line number: `bridge.py:153` in runbook, `bridge.py:156` observed.
- Install doc: "Hermes keeps plugin data directories on remove": no data directory existed to confirm this.
- Headless slash command: `hermes chat -q '/ultrathink-lessons'` does not route to the plugin command (Step 8a).

## Notes
- The plugin remained `disabled` after the failed remove and was removed only by the runbook's step 11 `rm` of the link. Re-running `plugins remove` after the link was gone was not attempted, to keep the runbook order.
- Operator's real install at `/root/.hermes/plugins/ultrathink` was untouched. It remains in place.
- Telegram incident (see Isolation): an isolated gateway polled Telegram with an inherited bot token for about 35 s. Recommend the operator check `TELEGRAM_*` handling if isolated runs are repeated; use `env -i`.
- `hosts/hermes/__pycache__/` created by validate (gitignored). Not removed.
