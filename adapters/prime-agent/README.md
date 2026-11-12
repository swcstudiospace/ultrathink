# Prime-Agent adapter

Thin host adapter that exposes the Ultrathink commands to Prime-Agent.

Prime-Agent is skills-only: it loads the skill manifest at `hosts/prime-agent/SKILL.md` and has no
command runtime of its own. This adapter therefore does not run any Prime-Agent-specific logic. It invokes
the same engine CLI as every other host, `bin/ultrathink <verb>`, and holds no engine logic.

## Commands

Each command runs `bin/ultrathink` once with its verb:

| Command             | Engine invocation       |
| ------------------- | ----------------------- |
| `ultrathink-quick`  | `bin/ultrathink quick`  |
| `ultrathink-skip`   | `bin/ultrathink skip`   |
| `ultrathink-off`    | `bin/ultrathink off`    |
| `ultrathink-on`     | `bin/ultrathink on`     |
| `ultrathink-track`  | `bin/ultrathink track`  |
| `ultrathink-status` | `bin/ultrathink status` |

All commands are `side-effecting`. Successful stdout is returned truncated to 4096 characters.

## Usage

```ts
import { createPrimeAgentAdapter, PRIME_AGENT_ENTRY_PATH } from "./index.ts";

const adapter = createPrimeAgentAdapter({
	runner, // spawns bin/ultrathink with the given argv
	entry: { exists: (path) => fs.existsSync(path) },
	entryPath: PRIME_AGENT_ENTRY_PATH,
});
```

The caller supplies `runner` and `entry`, so the adapter imports no Node modules and stays
runtime-neutral.

## Errors

| Condition                                  | Category             | Message                     |
| ------------------------------------------ | -------------------- | --------------------------- |
| Unknown command name                       | `invalid_input`      | `unknown command: <name>`   |
| `hosts/prime-agent/SKILL.md` not present   | `capability_missing` | `host entry point missing`  |
| Runner throws or exits non-zero            | `internal`           | `command failed`            |

Failure messages are fixed. Thrown text and engine output are never returned, because they may carry secrets.
