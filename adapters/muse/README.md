# Muse adapter

A thin `CommandPort` for the Muse Code host. Each core command runs one `bin/ultrathink <verb>` invocation through a runner the caller supplies. The adapter contains no engine logic and imports no Node APIs, so it stays host- and runtime-neutral.

## What it provides

| Export | Purpose |
| --- | --- |
| `createMuseAdapter({ runner, entry, entryPath })` | Returns a `CommandPort`. |
| `AdapterRunner` | `run(argv)` spawns `bin/ultrathink` and resolves `{ exitCode, stdout }`. |
| `AdapterEntry` | `exists(path)` reports whether a host entry point is present. |

## Commands

| Command | Runs |
| --- | --- |
| `ultrathink-quick` | `bin/ultrathink quick` |
| `ultrathink-skip` | `bin/ultrathink skip` |
| `ultrathink-off` | `bin/ultrathink off` |
| `ultrathink-on` | `bin/ultrathink on` |
| `ultrathink-track` | `bin/ultrathink track` |
| `ultrathink-status` | `bin/ultrathink status` |

Every command is `side-effecting`: each run sends messages or changes state, so the port adds no deduplication and repeating a command is not safe.

## Host entry point

Muse runs ultrathink through its `UserPromptSubmit` prompt hook, so the adapter's entry point is the Muse prompt hook, `hooks/muse-prompt`. Before every run, `invoke` checks `entry.exists("hooks/muse-prompt")`. If the file is missing, the command returns `capability_missing` with `host entry point missing` and the engine is not run.

Muse reads its plugin manifest from `.muse-plugin/plugin.json`. When both `.muse-plugin/` and `.claude-plugin/` exist, Muse selects `.muse-plugin/plugin.json` over `.claude-plugin`. The adapter does not read manifests itself.

## Errors

| Situation | Result |
| --- | --- |
| Name is not one of the six commands | `invalid_input`, `unknown command: <name>` |
| `hooks/muse-prompt` is absent | `capability_missing`, `host entry point missing` |
| Runner throws, or `bin/ultrathink` exits non-zero | `internal`, `command failed` |

On failure the thrown text and the engine's output are never returned, because they may carry secrets. On success, `value.stdout` is the engine's stdout truncated to 4096 characters.
