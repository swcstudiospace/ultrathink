# Grok Build adapter

Thin host adapter that exposes the core ultrathink commands to Grok Build. It contains no engine logic: each command runs one `bin/ultrathink <verb>` invocation through a caller-supplied runner.

## Commands

| Command | Runs |
| --- | --- |
| `ultrathink-quick` | `bin/ultrathink quick` |
| `ultrathink-skip` | `bin/ultrathink skip` |
| `ultrathink-off` | `bin/ultrathink off` |
| `ultrathink-on` | `bin/ultrathink on` |
| `ultrathink-track` | `bin/ultrathink track` |
| `ultrathink-status` | `bin/ultrathink status` |

Every command is `side-effecting`: the port adds no deduplication, so callers must not retry blindly.

## Entry point

`createGrokBuildAdapter({ runner, entry, entryPath })` takes `entryPath: "hooks/hooks.json"`. Grok Build loads the Claude-format plugin manifest, so the host entry is the same hooks file the Claude Code adapter uses. This adapter reuses `hooks/hooks.json` as its entry check and does not read `.grok/`. If `entry.exists(entryPath)` is false, every command returns `capability_missing` and the runner is not called.

## Dependencies

The adapter imports no Node or host modules. The caller supplies:

- `runner`: spawns `bin/ultrathink` with the argv it receives and resolves `{ exitCode, stdout }`.
- `entry`: reports whether a path exists.

## Errors

| Situation | Category | Message |
| --- | --- | --- |
| Unknown command name | `invalid_input` | `unknown command: <name>` |
| Entry point missing | `capability_missing` | `host entry point missing` |
| Runner throws, or non-zero exit | `internal` | `command failed` |

The runner's thrown text is never returned, because it may contain secrets. Successful stdout is returned in full. The 4096-character cap applies only to the JSON envelope printed by `bin/ultrathink-adapter` when `--raw` is not given.
