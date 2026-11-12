# Hermes adapter

This directory holds the Hermes host's thin `CommandPort` implementation. It translates each Hermes command into one invocation of the engine CLI, `bin/ultrathink <verb>`. It contains no engine logic.

## What it provides

| Factory | Port | Entry point |
| --- | --- | --- |
| `createHermesAdapter({ runner, entry, entryPath })` | `CommandPort` (`core/src/ports/command.ts`) | `hosts/hermes/bridge.py` (`HERMES_ENTRY_PATH`) |

The adapter has no Node imports. The caller supplies:

- `runner`: an `AdapterRunner` that spawns `bin/ultrathink` with an argv array and returns `{ exitCode, stdout }`.
- `entry`: an `AdapterEntry` whose `exists(path)` reports whether the host entry point is present.
- `entryPath`: the path to check. Pass `HERMES_ENTRY_PATH`.

## Commands

Hermes exposes these commands, one per engine verb:

| Command | Engine invocation |
| --- | --- |
| `ultrathink-quick` | `bin/ultrathink quick` |
| `ultrathink-skip` | `bin/ultrathink skip` |
| `ultrathink-off` | `bin/ultrathink off` |
| `ultrathink-on` | `bin/ultrathink on` |
| `ultrathink-track` | `bin/ultrathink track` |
| `ultrathink-status` | `bin/ultrathink status` |

Every command is `side-effecting`. The adapter adds no deduplication.

### Commands not wrapped

`ultrathink-learn` and `ultrathink-lessons` are Hermes-only commands. They are not `bin/ultrathink` verbs, so this adapter does not wrap them. Invoking either returns `invalid_input`.

## Behavior

- `invoke` runs the verb as `[verb]` only. Caller input is not forwarded to the engine.
- An unknown name returns `invalid_input`.
- A missing entry point returns `capability_missing` and does not run the engine.
- A runner that throws, or a non-zero exit, returns `internal` with the message `command failed`. Thrown text and stdout are never included, because they may carry secrets.
- Successful stdout is returned in full as `{ stdout }`. The 4096-character cap applies only to the JSON envelope printed by `bin/ultrathink-adapter` when `--raw` is not given.

## Import rule

Adapter code imports only types from `core/src/ports/command.ts`. It never imports from `src/` or from a host package.
