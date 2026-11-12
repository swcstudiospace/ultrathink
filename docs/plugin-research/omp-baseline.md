# Omp golden baseline

Manifest for the pre-refactor capture of the Omp host's `/ultrathink-*` commands. Procedure and normalization rules:
`test/golden/omp/README.md`. Capture script: `test/golden/omp/capture.ts`. Fixtures: `test/golden/omp/fixtures/`.

## Provenance

| Field | Value |
| --- | --- |
| Source commit | `01c6ee7589e0350920b77212450740b01d6556d4` (`git rev-parse HEAD`, branch `main-plugin`) |
| Working tree at capture | `src/` clean (`git status -- src` empty); tracked files clean |
| Capture date | 2026-11-12 |
| Omp version observed | CLI `omp --version` = `18.19.0` (`/root/.local/bin/omp`) |
| Omp packages (devDependencies) | `@oh-my-pi/pi-ai` 18.14.0, `@oh-my-pi/pi-catalog` 18.14.0 (installed in `node_modules`) |
| Host surface used | Mocked `ExtensionAPI` (same surface as `src/host/omp-test.helpers.ts`); no live Omp session was driven |

## Captured entry points

`createOmpExtension()` (the default export's factory) registers eight commands. All eight are captured, plus the
registration itself.

| Fixture | Command | Cases | Excluded variants |
| --- | --- | --- | --- |
| `registration.json` | (all registrations) | n/a | n/a |
| `ultrathink-status.json` | `/ultrathink-status` | 1 | 1 |
| `ultrathink-on.json` | `/ultrathink-on` | 1 | 0 |
| `ultrathink-off.json` | `/ultrathink-off` | 1 | 0 |
| `ultrathink-skip.json` | `/ultrathink-skip` | 1 | 0 |
| `ultrathink-track.json` | `/ultrathink-track` (`off`, `status`, `on`, `bogus`) | 4 | 0 |
| `ultrathink-quick.json` | `/ultrathink-quick` (message, no message) | 2 | 0 |
| `ultrathink-ui.json` | `/ultrathink-ui` (default, `jev`, `card`, `bogus`) | 4 | 1 |
| `ultrathink-swarm.json` | `/ultrathink-swarm` (usage, `status`, `stop`, brief refused) | 4 | 2 |

Total: 18 command cases in 8 command fixtures, plus the registration fixture (9 files).

## Excluded entry points (not captured live)

All four are `requires live host`:

- `ultrathink-status`: SuperGrok OAuth logged-in line. Needs a real `auth.json` under the operator's home; the sandbox home has none, so the captured line is the not-logged-in branch.
- `ultrathink-ui`: TUI panel mount (`ctx.mode === "tui"` with `ui.custom`). Needs an interactive session; the captured path is the non-TUI snapshot fallback.
- `ultrathink-swarm`: spawning lanes with a configured swarm root. Needs detached AgentSwarm lane processes from a real checkout. Only the refusal path (no root) is captured.
- `ultrathink-swarm`: stopping a running lane. Needs a live lane process to signal. Only `stop` with no lanes is captured.

## Determinism

Two consecutive runs of the final `capture.ts` (sha256 of run 1 fixtures below):

- Run 1: `bun test/golden/omp/capture.ts` writes `test/golden/omp/fixtures/`. Exit 0.
- Run 2: a separate process, `bun test/golden/omp/capture.ts --out <fresh mkdtemp dir>`, which gets a new sandbox root. Exit 0.
- `diff -r fixtures <run 2 dir>`: **no differences. Byte-identical across all 9 files.**

Run 1 sha256:

```
7bfc4cafda198ef279dbedc1f02728b2916790844a919ff6e149e0423531fa33  registration.json
f412e4ddf6711bb32c1e0bd59561a38addc0a407d9bfbec37c0dc44665d98129  ultrathink-off.json
932f72fbf9db09f95451633e996d2a87037abe5d7086e0566ce9dd526d726996  ultrathink-on.json
378a829534bcd1f2c137086200f6b09c0d8b779c24852203ef10424f9da8d96c  ultrathink-quick.json
e3bbaf4c1c34c08ac5eaadac3c4268d188c8fdb05e439cdc85f0bb253b10f8b5  ultrathink-skip.json
f6ab23b600f147481329802bcdcbc02eb94d383cbb815c0b2b8b66217395710c  ultrathink-status.json
489e468ec657dbb1104bf9337d7a3ffc030c6311635d0303b4a17f0fb5b298f1  ultrathink-swarm.json
21ad09ffdad410d7846633661817ed93f06eb2174d9050b0fb5505210731510b  ultrathink-track.json
a8925f63628451c755b818f601e4ea6f4d91c90770d34f61f03653d1b44fba9c  ultrathink-ui.json
```

Nondeterminism found and normalized during the work (none left unexplained):

- The `ultrathink-ui card` details carry a numeric `at` epoch (`1794494868975`). Strings-only normalization missed it; a numeric epoch rule was added, so it records as `<TS>`.
- The sandbox root differs per run (`mkdtemp`). Recorded as `<ROOT>`.
- The `State:` line of the status output contains the sandbox root (the state dir lives under the sandbox). Recorded as `<ROOT>`.

Fixture lines containing each placeholder: `<ROOT>` 19, `<TS>` 1, `<ID-n>` 0. The ID rule is in place, but no generated ids appeared in the captured outputs.

## Secret handling

- Secret-named variables (names matching `/TOKEN|KEY|SECRET|PASSWORD/i`) were set to `<REDACTED>` in the capture process. Count at capture: 12.
- Environment is pinned to an allowlist (`PATH`, `TMPDIR`, `TZ=UTC`, `LANG`/`LC_ALL=C.UTF-8`) plus sandbox dirs. Host configuration is dropped.
- Grep over `test/golden/omp/fixtures` for `TOKEN|KEY|SECRET|PASSWORD` (case-sensitive): **one match, not a secret.** `ultrathink-status.json` line 16 contains the env-var name `ULTRATHINK_OPENROUTER_KEY` inside a user-facing hint ("…or ULTRATHINK_OPENROUTER_KEY"). It is a name, not a value.
- Check that no real secret value appears: each of the 12 real secret-named values (length ≥ 6) was searched for in the fixtures, counted only. **0 found.**
- No `<REDACTED>` placeholder appears in any fixture (0), so no secret-named variable's value was echoed by any command.

Caveat: the set of secret-named variables present on a machine changes what the code under test sees (as `<REDACTED>`). A comparison run on a host with a different set is not valid without re-capturing. The count above is recorded for that reason.

## Source tree

`git status --short -- src`: empty. No file under `src/` was modified. The only new paths are `test/golden/omp/` and `.planning/research/omp-baseline.md`. (`.gsd-run/` was already untracked before this work.)

## Coverage limits

This baseline covers the command surface and the registration: names, descriptions, argument completions, subscribed event names, and renderer types. It does not capture hook handlers (`before_agent_start`, `agent_end`, `tool_result`, `session_*`, `turn_start`, and `message_*` observers), the planning pipeline, or the quick bypass on the next prompt. Those need a separate capture before a refactor that touches them.

## Hook coverage (pi.on handlers)

This section covers the hook handlers `src/host/omp.ts` registers with `pi.on`, captured by `test/golden/omp/capture.ts` (method in
`test/golden/omp/README.md`, "Hook handlers"). It supersedes the "Coverage limits" paragraph above for the hooks listed here. Omp
behaviour is frozen: no file under `src/` was changed.

| Field | Value |
| --- | --- |
| Source commit | `9f179d3f3a3999f6dbb8718646926b957d615166` (`git rev-parse HEAD`, branch `plugin-core-slice`) |
| `src/` at capture | clean (`git status --short -- src` empty) |
| Capture change | `test/golden/omp/capture.ts`, `test/golden/omp/README.md`, `hook-*.json` fixtures (uncommitted working tree); command cases unchanged |
| Capture date | 2026-11-12 |

### Hook coverage

| Fixture | Handler(s) registered | Cases | Excluded |
| --- | --- | --- | --- |
| `hook-session-start.json` | `session_start` ×1 | 1 | 2 |
| `hook-session-switch.json` | `session_switch` ×1 | 3 | 2 |
| `hook-session-shutdown.json` | `session_shutdown` ×1 | 2 | 3 |
| `hook-observe.json` | `agent_start`, `turn_end`, `tool_execution_start`, `tool_execution_end` ×1 each | 2 | 2 |
| `hook-turn-start.json` | `turn_start` ×1 | 2 | 1 |
| `hook-tool-result.json` | `tool_result` ×2 (edit attribution; PR-sync nudge) | 6 | 1 |
| `hook-agent-end.json` | `agent_end` ×2 (observer; teach observe handoff then ship nudge) | 6 | 2 |

Total: 22 hook cases in 7 fixtures, 13 excluded variants. `agent_end` and `tool_result` each have two registrations; both run on every event and are recorded by index.

Not covered here: `before_agent_start` (planner flights, plan delivery, quick bypass, re-run gate). It is outside this hook list and needs a
model provider over the network, so it stays `requires live host`. The `substrate:status` and `token-opt:savings` handlers are on `pi.events`, not `pi.on`.

### Findings from the capture

- A non-TUI `/ultrathink-ui` closes its own lifetime when its snapshot finishes (`sendSnapshotFallback` calls `teardownInsight`). So on a non-TUI
  host, `session_switch`, `session_shutdown` and the observer have no open dashboard to close, and the fixtures record silence. The "closed with a
  notice" path exists only in the TUI and is excluded.
- `session_start`'s activity-receipt poll and bar mount run only when `ctx.mode` is `tui` with `ui.setWidget`. Non-TUI start records no output.

### Determinism

- Run 1: `bun test/golden/omp/capture.ts` → `fixtures/` (exit 0; 16 files).
- Run 2: `bun test/golden/omp/capture.ts --out /tmp/omp-hook-run2.0FJj` (exit 0; 16 files).
- `diff -r fixtures /tmp/omp-hook-run2.0FJj`: **no differences, byte-identical across all 16 files.**
- The nine pre-existing fixtures (`registration.json` and eight command fixtures) are byte-identical to their state before this change.

Nondeterministic values found and normalized (each added to the README rule list):

1. Teach inbox file names `<epoch ms>-<8 random hex>.json` (rule 11): the random part → `<RAND>`. Real randomness; differs every run.
2. Launch paths into the checkout (`<REPO>/src/teach/launch-supervisor.ts`, `<REPO>/bin/run-bun`) (rule 10): machine-specific, not random.
3. Side-effect manifest order when two files share one normalized name (the two inbox digests of one GSD case): sorted by normalized path, then content (rule 9).

Setup git repositories are not in the manifest (they exist before the baseline snapshot) and use pinned identity and dates in any case.

sha256 of run 1 hook fixtures:

```
6a35ac9ead177132da9842b808b07fb879bdd038df28c87db85256810570860b  hook-agent-end.json
0a63c7f6964e674d8a15f53da77ed279653b84c3749ba8065e7bab95df831494  hook-observe.json
0296d7b701472788e4fc4265eac7a83414a5b664c9e6d6978779f95db968b9a8  hook-session-shutdown.json
8c9adfc715b6df1a145224e286e9504abcd2c361c18f05640dd9b4145bf74af4  hook-session-start.json
f3319ec230a52b152a3d0699a0ca5ff0ce45b6ea16c37e1c9c363d9534325cbc  hook-session-switch.json
a08d3537ca2260e8086e7e01f8a86c55b34bb7dc0a2314dc827a7ba4e54b4528  hook-tool-result.json
624a0f390a1dd900c0f36602143a7c657db6b0715eacababd36e700dbd050ef8  hook-turn-start.json
```

### Hook exclusions

All are `requires live host`, each recorded in its fixture's `excluded` array:

- `session_start`: TUI activity-receipt poll and status-bar mount; live session id held in the bar store (read only by the TUI).
- `session_switch`: a running planner flight cancelled (needs the model provider); TUI dashboard mount and disposal.
- `session_shutdown`: TUI activity poll; running planner flight cancelled; TUI dashboard open at shutdown.
- `agent_start`/`turn_end`/`tool_execution_*` observer: planner flight cancelled when the session or cwd changed; TUI dashboard silently torn down.
- `turn_start`: the turn counter gates the `before_agent_start` re-run check, which needs the model provider.
- `tool_result`: a PR opened by a subagent session (needs a live subagent session-file layout).
- `agent_end`: the ship skill run after the nudge (PR, Greptile, merge over the network); the `teach observe` supervisor actually running (the launch is recorded, never started).

### Secret handling

- `grep -rnE "TOKEN|KEY|SECRET|PASSWORD" test/golden/omp/fixtures`: **one match**, `ultrathink-status.json` line 16, `ULTRATHINK_OPENROUTER_KEY` inside a user-facing hint. Verdict: an environment variable name, not a value. No match in any hook fixture.
- Value-level check: 12 secret-named variables in the capture environment, 12 values of length ≥ 6 searched for across all fixtures, **0 found**. `<REDACTED>` placeholders in fixtures: 0.
- The launch record keeps only `ULTRATHINK_*` environment entries, so no secret-named variable can reach a fixture through it.

### Source tree

`git status --short -- src`: empty. The change touches only `test/golden/omp/**` and this file.
