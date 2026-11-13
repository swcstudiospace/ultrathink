# Omp module classification (n4, step 7)

Source: `src/host/omp.ts` (2,905 lines, default export `createOmpExtension()`) read at commit `9f179d3`, date 2026-11-12. This is a classification only. No code moves in this step.

## Categories

| Category | Where it lives in `src/host/omp.ts` | Disposition |
|---|---|---|
| Omp registration | `pi.on(...)` lifecycle hooks (`session_start`, `session_switch`, `session_shutdown`, `turn_start`, `tool_result`, `agent_end`), `pi.registerCommand?.(...)` (8 `ultrathink-*` commands, including `ultrathink-ui` and `ultrathink-swarm`), `pi.registerMessageRenderer` (lines ~1574, ~2402, ~2447, ~2728) | Stays in the Omp adapter. Behind `LifecycleEventPort` and `CommandPort`. |
| Omp messaging | `pi.sendMessage(...)` (lines ~1746, 1777, 1801, 2068, 2178, 2262, 2488, 2571) | Stays in the Omp adapter. Core returns output; the adapter delivers it. |
| Omp runtime types | `@oh-my-pi/pi-ai` type imports (`ExtensionAPI`, `OmpPlanRequest`, `NativeEngineDeps`, etc.) | Stays in the Omp adapter. Never imported by `core/`. |
| Config and state-dir resolution | `loadConfig`, `claudeConfigPaths` (src/config.ts), `resolveStateDir({ ...process.env, ULTRATHINK_HOST: "omp" })` (lines ~1430, 1714, 2216) | Read through an injected config port. The `ULTRATHINK_HOST` value is adapter-supplied. |
| Direct env, fs, process | `process.env` (lines ~1011, 1430, 1714, 2216, 2370, 2389, 2396, 2411), `readFileSync` and `existsSync` imports, `homedir()`, `resolvePstack` reading `~/.cursor` | Behind `FileSystemPort`, `ProcessPort`, and an injected env. Direct reads move out. |
| Swarm and lane orchestration | `resolveSwarmRoot(process.env)`, `orchStatusRunner`, `parseLaneArgs` (lines ~2370-2400) | Command logic that runs through `ProcessPort`. Only the Omp-facing wrapper stays in the adapter. |
| Pure workflow logic | `src/ship/*`, `src/teach/*`, `src/claude/state.ts`, `src/memory-chain.ts`, `src/redact.ts`, `src/resilience/*`, `src/think/*`, `src/uplift/*` | Not moved in this milestone. The new `core/` package holds only ports and the capability manifest. Moving these would change output and invalidate the golden fixtures. |

## Coupling inventory (counts)

- `process.env` and direct fs, process, or time calls in `omp.ts`: 27 matching lines.
- `pi.on` registrations: 7 handlers. `pi.registerCommand` registrations: 8 commands plus the `ultrathink-*` fallback loop.
- `pi.sendMessage` call sites: 8.

## Golden coverage gap

The golden fixtures (`test/golden/omp/fixtures/`) cover the 8 command handlers and the registration record. They do NOT cover the `pi.on` hook handlers (`session_start`, `session_switch`, `session_shutdown`, `turn_start`, `tool_result` x2, `agent_end`). Those handlers must be captured before any Omp code path behind them moves. This is an open item for n2 and blocks the Omp migration in Wave 3.

## Open facts recorded per n4 step 7

- The real Omp config format: `loadConfig` in `src/config.ts`. Not yet read in full. Open.
- Whether `ULTRATHINK_HOST` must be set by the adapter or by the host. Open. Source: `src/host/detect.ts` (not read in this pass).
- Omp CLI version observed: 18.19.0, against the devDependency `@oh-my-pi/pi-ai` 18.14.0. Recorded in `test/golden/omp/` manifest.
