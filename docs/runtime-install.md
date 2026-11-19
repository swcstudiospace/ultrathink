# Runtime installer

`bun run runtime-install` copies this checkout's Claude-format skills and commands into a CLI agent that has no ultrathink host adapter. It does not add a host id, does not load the planning engine, and does not claim the agent can gate a turn or pick a model per call.

The six built hosts (Claude Code, Grok Build, Hermes Agent, Muse Code, Omp, Prime Agent) keep their existing adapters. Omp stays on `src/host/omp.ts` and the Omp plugin. Do not install those hosts through this command.

## What it writes

Sources are `skills/ultrathink-*/SKILL.md` and `commands/ultrathink-*.md` in the checkout. Host-specific files under `hosts/**` are not copied.

Each written file carries an `ultrathink-managed` marker naming the source and the checkout. A file that is not `ultrathink-*` is never created or replaced. A file the installer did not write, or that you edited after install, is copied to `<config-root>/ultrathink-backups/<hash>/<path>` before it is replaced. A symlink or a non-text file at a managed path is refused.

Every path and keyed edit is recorded in `<config-root>/.ultrathink-install.json`. Uninstall removes exactly those paths and undoes those edits. It does not delete backups, and it does not touch GSD-Core files.

`descriptor.hooks` is recorded as `none`, `json`, or `toml`. The installer does not register hooks from that field. Hook formats for these agents are unverified.

## Command

```
bun run runtime-install -- <install|uninstall|list> --runtime <id|all> [--dry-run] [--global|--local]
```

`--runtime all` installs only into agents whose config root already exists. A missing root is skipped, not created. `--dry-run` writes nothing. Exit 2 is a bad argument; an unknown id is an error.

## Agents

One descriptor per agent lives in `src/runtime-install/runtimes.ts`. Config roots, layouts, and scope come from [GSD-Core findings](gsd-core-findings.md) and [the agent matrix](agent-matrix.md). A cell those docs mark unverified or conflicting stays unverified.

| id | layout note |
|---|---|
| kimi, kimi-code, kilo, opencode, pi, codex, copilot, antigravity, augment, trae, qwen, codebuddy, cline, zcode | skills, commands, or both, from the findings |
| windsurf | workspace only (`.windsurf`); a global install is a no-op |

Gating is `unverified` on all fifteen. Model routing is `per-call` only where the matrix already records a host model mode (OpenCode, pi, Cline), `none` where selection is UI-only (Windsurf, Trae), and `unverified` where the docs do not say (Kilo, ZCode). None of that is proven by a live install in this repository.

## What this is not

- Not a conformance adapter. Detection, doctor, and the golden Omp fixtures do not know these ids.
- Not a gate. A skill file in the agent's directory does not hold a turn until the plan exists.
- Not a model router.
- Not verified on a live agent. The tests install into a scratch home.
