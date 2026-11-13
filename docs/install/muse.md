# Install ultrathink in Muse Code

## Requirements

- Verified on Muse Code 1.4.18 (`1.4.18-R8587.1`, Linux x64) in isolated homes. The earlier observation was 1.4.14.
- Minimum supported Muse version: not documented. Community reports of plugin support from 1.3.0 are unverified.
- The hooks run through `bin/run-bun`. Their scripts exit 0 when `bun` is missing, so prompts proceed with no planning and no error.
- Planning runs Muse's own model. Without Meta credentials the engine fails (`missing meta credentials`), and the UserPromptSubmit hook emits a degraded fallback spec. The hook still runs and writes its record.

## Install

Run from the repo root, with no other process writing to the checkout. Muse selects `.muse-plugin/plugin.json` there.

```sh
muse plugins install . --scope user
muse plugins approve ultrathink
```

- `--scope` accepts `user` or `project`. The help does not state a default.
- The plugin ID is the manifest name, `ultrathink`. Confirm it with `muse plugins list`.
- The install copies the whole checkout into the plugin cache. If a file changes during the copy, the install fails with `held project plugin source inventory changed during snapshot`.
- Marketplace form: `muse plugins install ultrathink@<marketplace>` after `muse plugins marketplace add`.

## Activate the hooks

Install alone does not activate the hooks. Verified on 1.4.18 with an install that was never approved: `muse plugins inspect ultrathink` reports `status=review_needed` for `plugin:ultrathink:hook:user-prompt-submit`, `plugin:ultrathink:hook:stop`, and `plugin:ultrathink:hook:post-tool-use`. A keyless `muse exec` run recorded no hook event.

`muse plugins approve ultrathink` sets all three to `status=trusted_enabled`. It stores each hook's `enabled` and `trusted_definition_hash` in `settings.json` under `runtime_capabilities`. Two installs of this manifest with different package digests produced the same definition hash, so approval follows the hook definition, not the package digest.

Muse reports `changed since you approved it, so it needs review again` when a hook definition changes. After you change the manifest's hook entries or the hook scripts, run `muse plugins inspect ultrathink`, and run `approve` again if it reports `review_needed`.

The `hooks require review before activation` warning stays after approval. It is informational.

## Verify the install

```sh
muse plugins list
muse plugins inspect ultrathink
```

`inspect` must show `status=trusted_enabled` for all three hook capabilities.

## Verify that a prompt runs the hook

Keyless, with the echo provider:

```sh
cd <any workspace>
muse exec --provider echo "Plan a small change: add a README line."
grep -h '"kind":"hook_run_terminal"' ~/.local/share/muse/sessions/*/*/*/*/session.jsonl
```

Muse's `exec` stdout does not contain hook events. The hook's run is recorded in the session log, `~/.local/share/muse/sessions/<YYYY>/<MM>/<DD>/<session-id>/session.jsonl`. An approved hook shows a `hook_run_terminal` record for the event `UserPromptSubmit`, for the hook key plugin ultrathink user-prompt-submit, with status `completed`, exit code 0, effects `context`, and a `system_message` that starts with `Prompt Uplift`.

The hook also writes its record to the state directory, `$XDG_CONFIG_HOME/muse/ultrathink` or `~/.config/muse/ultrathink`: `last-plan.<session-id>.json`, `last.json`, and `sessions/<session-id>.json` with `.xml` beside it.

A prompt takes 30 to 45 s here. The planning engine runs `muse completion` first and fails without credentials. With `muse` off `PATH`, the hook's fallback alone takes about 5 s.

## Test the hook without a prompt

```sh
muse plugins hook test ultrathink:user-prompt-submit --fixture fixture.json --json
```

`fixture.json` is `{"event": "UserPromptSubmit", "stdin": { ...the Claude-shaped UserPromptSubmit payload... }}`. The output's `terminals[0]` gives `exit_code`, `effects`, and the hook's `stdout`.

`hooks/muse-prompt.test.ts` runs the registered command against a sample payload, without a model or credentials, and asserts the output and the record.

## Reload

Start a new session. A new `muse exec` session ran the approved hooks with no restart (verified). `enable` and `disable` apply "for future runtime loads". Reloading inside a running session is not documented.

## Uninstall

```sh
muse plugins remove ultrathink
```

`--delete-data` is accepted. The help does not say what it deletes, and the plugin data directory is not documented.

## Permissions

`.muse-plugin/plugin.json` declares 5 skills, 6 commands, and 3 hooks, with no MCP servers, reminders, or agents. The hooks set `ULTRATHINK_HOST=muse` and run through `bin/run-bun`:

| Event | Script | Timeout | Purpose |
|---|---|---|---|
| `UserPromptSubmit` | `hooks/muse-prompt` runs `hooks/uplift.ts` | 600000 ms | Plans each prompt with the ultrathink engine |
| `PostToolUse` | `hooks/muse-post-tool` runs `hooks/pr-sync.ts` | 10000 ms | PR sync check; no matcher, so it sees every tool call and filters to PR creation |
| `Stop` | `hooks/muse-stop` runs `hooks/stop.ts` | 5000 ms | Sync nudge |

Each hook runs only after `approve`. Muse documents that hooks run outside the sandbox and approval policy. Install only plugins you trust.

## Known limitations

- Muse has no public bundle specification. `.muse-plugin` support is observed from the binary and validator only.
- When both `.muse-plugin/plugin.json` and `.claude-plugin/plugin.json` exist, Muse selects `.muse-plugin` and ignores `.claude-plugin` (`multiple-manifests` warning). Claude Code and Grok Build still read `.claude-plugin`.
- Validate from the repo root. `muse plugins validate .muse-plugin` fails with `missing-manifest`.
- Repo-root validation reports `diagnostics=2`: the precedence warning and a symlink warning for `hosts/prime-agent/.venv/bin/python`, which escapes the package root. The plugin still validates. That path is inside `hosts/prime-agent/.venv/`, a local-only virtualenv that `hosts/prime-agent/.gitignore` excludes (`.venv/`). It is not part of the repo.
- Experimental gate: the verified runs used the `muse` on `PATH`, a wrapper that sets `MUSE_EXPERIMENTAL_PLUGINS=1` by default. Runs without the flag were not repeated.
- A headless run does not log a skipped hook. An unapproved hook is visible only in `muse plugins inspect`.
- Minimum Muse version and plugin data directory: not documented.

## Sources

- Verified on Muse Code 1.4.18 in isolated homes, `/tmp/ut-matrix/muse2/home` and `/tmp/ut-matrix/muse-fix/unapproved/home`. The hook was run directly, through `muse plugins hook test`, and through `muse exec`.
- `host-contracts.md`, section 6 (Muse Code), keys S-MU-LOCAL, S-MU-REPO, S-MU-EXT, S-MU-CFG, S-MU-REL. S-MU-SNIP is secondary and was used only as a lead.
- Repo files: `.muse-plugin/plugin.json`, `hooks/muse-prompt`, `hooks/muse-prompt.test.ts`, `hooks/muse-post-tool`, `hooks/muse-stop`, `hosts/prime-agent/.gitignore`.
