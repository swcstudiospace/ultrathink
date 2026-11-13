# Claude Code adapter

A thin `CommandPort` for the Claude Code host. It contains no engine logic. Each command translates into one invocation of the engine CLI, `bin/ultrathink <verb>`, and returns its stdout.

## Commands

| Command | Engine argv |
| --- | --- |
| `ultrathink-quick` | `bin/ultrathink quick` |
| `ultrathink-skip` | `bin/ultrathink skip` |
| `ultrathink-off` | `bin/ultrathink off` |
| `ultrathink-on` | `bin/ultrathink on` |
| `ultrathink-track` | `bin/ultrathink track` |
| `ultrathink-status` | `bin/ultrathink status` |

Every command is `side-effecting`: repeating one is not safe.

## Factory

`createClaudeCodeAdapter({ runner, entry, entryPath })` takes:

- `runner`: an `AdapterRunner` that spawns `bin/ultrathink` with the given argv and resolves `{ exitCode, stdout }`. The caller supplies it, so the adapter imports no Node or Bun APIs.
- `entry`: an `AdapterEntry` whose `exists(path)` reports whether the host entry point is present.
- `entryPath`: `hooks/hooks.json`, the Claude Code hooks manifest.

## Results

- Unknown command: `invalid_input` (`unknown command: <name>`). The runner is not called.
- Entry point missing: `capability_missing` (`host entry point missing`). The runner is not called.
- Runner throws, or exits non-zero: `internal` (`command failed`). The thrown text and stderr are never returned, because they may carry secrets.
- Success: `{ ok: true, value: { stdout } }`, with `stdout` the full child stdout. The 4096-character cap applies only to the JSON envelope printed by `bin/ultrathink-adapter` when `--raw` is not given.

## Import rule

`index.ts` imports types only from `core/src/ports/command.ts`. It never imports from `src/` or from a host package.
