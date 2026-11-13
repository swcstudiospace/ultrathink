# Plugin permission model, per host

Scope: the five host surfaces named in the research brief (claude-code, grok-build, muse, hermes, prime-agent), the shared CLI adapter, and the launchers they call. Paths are relative to the repo root. Line numbers refer to the working tree at HEAD `5f76f14`. Read-only research; no code was changed.

Citation format: `cli.ts:N` means `adapters/cli.ts` line N. Where a file was read only through grep, the cited line is that grep match. `UNVERIFIED (check <file>)` marks a claim I could not confirm from a file read. Engine files under `src/` are cited because every host reaches them through `bin/ultrathink`.

---

## Core baseline

The baseline the brief sets, with what the code actually does:

| Clause | Baseline | Observed |
|---|---|---|
| Read | project root | Project config `<cwd>/.claude/ultrathink.json` (`src/config.ts:1145`). Also reads user config, host config, the MCP credential store, transcripts, and `~/.grok/auth.json`. **Beyond baseline.** |
| Write | project root and plugin state directory only | State writes go to the host state directory (`src/host/paths.ts:18-53`). **Beyond baseline:** MCP credentials in `~/.config/ultrathink/` (`src/mcp/store.ts:51-55`), skill install into host skill dirs (`src/teach/promote.ts:447-452`), and the grok login config (`src/grok/login.ts:84-96`, target UNVERIFIED). No project-root file writes found in the reviewed hook and engine paths. |
| Network in core | none | **Beyond baseline.** Decisions API (OpenRouter), Linear/Notion via MCP, Greptile via MCP (opt-in), Agent Substrate (opt-in), Grok HTTP, and GitHub via `gh`. See the consolidated list. |
| Spawn | allowlist only: `bin/ultrathink`, `bin/run-bun`, adapter CLI | **Beyond baseline:** `claude`, `grok`, `muse`, `git`, `gh`, `tailscale` (opt-in), interpreter version probes, and `bun` executed directly when `BUN` is set. Launchers are allowlisted; the processes they start are not. |

**Verdict:** the baseline holds for the adapter layer itself (the adapter modules have no I/O of their own; see §1). It does not hold for the engine the adapters run. The "no network in core" clause is the most divergent. Each deviation is listed under *Permissions outside the core baseline* (§4).

### Recorded decisions

- **D1. MCP credentials file is an intentional, documented exception to the baseline.**
  - Decision: `~/.config/ultrathink/mcp-credentials.json` stays in the user config directory, outside the state dir and project root. Documented at lines 94, 143, 211, 340.
  - Reason: it is the user's own config directory, and moving it would break MCP auth. Line 143 supports the cross-host part (one login serves every host); the MCP auth consequence is UNVERIFIED (check `src/mcp/client.ts:224-231`).
  - Opt-in: none. This is an exception, not an opt-in. The closest trigger is the user-run `bin/ultrathink-mcp auth login` (`hosts/prime-agent/SKILL.md:56`, cited at line 395).
  - Enforcing file: none cited. Path defined at `src/mcp/store.ts:51-55`; write at `src/mcp/store.ts:133-140` (line 340).
- **D2. `teach promote --install` writing to `~/.claude/skills` and `~/.prime/agent/skills` is an opt-in exception.**
  - Decision: skill writes to `~/.claude/skills/<name>/SKILL.md` and `${PRIME_AGENT_CODING_AGENT_DIR:-~/.prime/agent}/skills/<name>/SKILL.md` happen only with the explicit `--install` flag. Write sites: `src/teach/promote.ts:451-452` (claude), `:447-449` (prime-agent), `:318` (`flag: "wx"`). Documented at lines 95, 144, 303, 341-342.
  - Reason: the user must choose it.
  - Opt-in: the explicit `--install` flag.
  - Enforcing file: `src/teach/promote.ts`. The line that checks `--install` is UNVERIFIED (check the flag handling in `src/teach/promote.ts`; not cited in this document).

---

## 1. Shared adapter layer (applies to all hosts)

### 1.1 What the adapter modules do

- The five adapter modules have no I/O. Each receives an injected `AdapterRunner` and `AdapterEntry` and calls only `entry.exists(...)` and `runner.run([verb])`:
  - claude-code: `adapters/claude-code/index.ts:70` (exists), `:76` (run). Imports types only (`:4-10`).
  - grok-build: `adapters/grok-build/index.ts:17` (states "no node imports"), `:73`, `:77`.
  - muse: `adapters/muse/index.ts:12` (states "imports no Node APIs"), `:78`, `:84`.
  - hermes: `adapters/hermes/index.ts:78-79`, `:82`.
  - prime-agent: `adapters/prime-agent/index.ts:88`, `:93`.
- The only real I/O is in `adapters/cli.ts`:
  - `cli.ts:196-198`: `existsSync(join(REPO_ROOT, path))`. This is a stat on the entry file under the repo root.
  - `cli.ts:167-193`: `execFile(binPath, argv, { env: { ...process.env, ...env } })`. `execFile` is used, not a shell (`cli.ts:174-177`). The child receives the full process environment merged with the host's `env` entry.
  - `cli.ts:202`: `binPath` is `bin/ultrathink`.
- Verbs are fixed to `quick, skip, off, on, track, status` (`cli.ts:80`, validated at `:121`). Host names are checked with own-property lookup (`cli.ts:119`).
- Extra arguments are not validated. They are appended to the engine argv: `cli.ts:111` (filter), `:128` (`[...childArgv, ...extra]`). Example: `ultrathink-adapter claude-code status --session X` passes `--session X` to `bin/ultrathink`. Not a shell injection, but the adapter does not restrict flags.

### 1.2 Launchers

- `bin/ultrathink-adapter` (`:14-15`) and `bin/ultrathink` (`:15-16`) resolve their repo root and `exec "$root/bin/run-bun" ...` with `ULTRATHINK_BUN_REQUIRED=1`.
- `bin/run-bun`:
  - Finds `bun` in this order: `$BUN` (`:14`), `PATH` (`:18`), `$BUN_INSTALL/bin/bun`, `~/.bun/bin/bun`, `/usr/local/bin/bun`, `/opt/homebrew/bin/bun`, `~/.local/share/*/bun/bin/bun` (`:22-27`).
  - Unsets `ULTRATHINK_BUN_REQUIRED` (`:43`) and prepends the found bun's dir to `PATH` (`:44`).
  - Runs `bun --no-env-file` (`:48`), so a cloned repo's `.env*` is not loaded.
  - Without `ULTRATHINK_BUN_REQUIRED=1`, it exits 0 on any failure (`:11`, hook fail-open).

**Permission from this layer:** spawn `bun` (resolved as above) and run the repo's TypeScript entries. The `bun` lookup set goes beyond "the repo's own binary".

### 1.3 Hook wiring (`hooks/hooks.json`, consumed by claude-code and grok-build)

| Event / matcher | Command (via `run-bun`) | Timeout | Lines |
|---|---|---|---|
| UserPromptSubmit | `hooks/uplift.ts` | 86400 s | `:3-9` |
| PostToolUse `AskUserQuestion` | `hooks/answers.ts` | 30 s | `:16-22` |
| PostToolUse `^(Bash\|bash\|…)$` | `hooks/pr-sync.ts`, `hooks/flow-eval.ts` | 30 s each | `:27-40` |
| PostToolUse `^(Skill\|skill)$` | `hooks/flow-eval.ts` | 30 s | `:43-51` |
| PostToolUse `…create…pull…request…` | `hooks/pr-sync.ts` | 30 s | `:54-60` |
| Stop | `hooks/stop.ts` | 60 s | `:64-73` |

All commands are `"${CLAUDE_PLUGIN_ROOT}/bin/run-bun" "${CLAUDE_PLUGIN_ROOT}/<hook>.ts"`. Claude-code and grok-build share this file (`adapters/cli.ts:69-70`).

---

## 2. claude-code

**Surface:** `hooks/hooks.json` (entry, `adapters/cli.ts:69`). Host detection falls through to claude-code when no other host marker is set (`src/host/detect.ts:17-26`, default at `:25`). No `.claude-plugin/plugin.json` hook or command declarations (`.claude-plugin/plugin.json:1-10` contains only metadata).

### (1) Files read

- Hook stdin JSON, including the host's transcript path: `hooks/stop.ts:53`. Transcript reader: `hooks/uplift.ts:22`.
- Session records: `src/claude/state.ts:233-235` (`<stateDir>/sessions/<id>.json`). Read by `hooks/pr-sync.ts:45`.
- User config: `~/.config/ultrathink/config.json` (`src/config.ts:1124-1131`), or `$XDG_CONFIG_HOME/ultrathink/config.json`.
- Claude config: `$CLAUDE_CONFIG_DIR/ultrathink.json` or `~/.claude/ultrathink.json` (`src/config.ts:1141-1144`).
- Project config: `<cwd>/.claude/ultrathink.json` (`src/config.ts:1145`). The project layer cannot set spawn binaries (`src/config.ts:394`; asserted by `src/config.test.ts:427`).
- MCP credentials: `~/.config/ultrathink/mcp-credentials.json` (`src/mcp/store.ts:51-55`), read by the tracker (`src/track/gateway.ts:9-10`) and by `createMcpClientIfCredentialed` (`src/mcp/client.ts:224-231`).
- Grok login: `~/.grok/auth.json` (`src/grok/auth.ts:63`, `:88`), only when a Grok route is used.
- Git metadata via `git` (`src/track/git.ts:26-32`).

### (2) Files written

- **State directory** `${CLAUDE_CONFIG_DIR:-~/.claude}/ultrathink/` (`src/host/paths.ts:46-49`). Writes:
  - Session record: `src/claude/state.ts:112`, via `writeFileAtomic` (`src/claude/atomic.ts:109-121`, mode 0600).
  - Spec XML: `src/claude/hook.ts:225-227` (`specFile`), `:345` (write).
  - Plan carrier: `src/host/carrier.ts:113-128`.
  - Skip-once flag: `src/claude/state.ts:292`.
  - Decisions health: `src/decisions/health.ts:209`.
  - Failover cooldowns: `src/host/engine.ts:202-204`.
  - Teach inbox and run log: `src/teach/spawn.ts:42-44`, `:84-101`; `src/teach/runlog.ts:110`.
  - Answer XML: `hooks/answers.ts:57`.
- **Outside the state directory:**
  - MCP credentials: `~/.config/ultrathink/mcp-credentials.json` (`src/mcp/store.ts:51-55`, `:133-140`; dir 0700, file 0600).
  - Skill install on `teach promote --install`: `~/.claude/skills/<name>/SKILL.md` (`src/teach/promote.ts:451-452`, file write at `:318` with `flag: "wx"`).
- **Project root:** no writes found in `hooks/*.ts` or `src/claude/*.ts`. The PR path (`ship`) runs `git`/`gh` against the repo (see §2 (3)); whether it writes project files is UNVERIFIED (check `src/ship/` git commit paths).

### (3) Processes spawned

- `bin/run-bun` for each hook (`hooks/hooks.json:8,21,31,36,47,58,69`).
- `bin/ultrathink teach observe` as a detached child. `hooks/stop.ts:31`, `:70-75` → `src/teach/spawn.ts:25-27`, `:122-128` → `src/teach/launch-supervisor.ts:51-56` (`spawn(task.command, args, { detached: true, stdio: "ignore" })`). Allowlisted at the top level; the supervisor runs as `bun`.
- **Planning engine: `claude` CLI.** Default `bin: "claude"` (`src/config.ts:89`). Spawned via `runChild` at `src/claude/complete.ts:301-305`. Detached process group (`src/resilience/child.ts:123-126`).
- **Grok CLI** (only on a Grok route): default `bin: "grok"` (`src/grok/types.ts:60`); planning spawn `src/grok/complete.ts:481-485`; auth refresh `grok models` via `Bun.spawn` (`src/grok/auth.ts:162-168`, `:220-221`); login with inherited stdio (`src/grok/login.ts:49-54`).
- **Muse CLI** (only on a Muse route): default `bin: "muse"` (`src/muse/types.ts:33`); `src/muse/complete.ts:137-141`.
- **`git`**: `src/track/git.ts:26-32` (`Bun.spawnSync`, 2 s timeout, `src/omp.ts` shares the pattern).
- **`gh`**: `src/ship/github.ts:239`, `:340`, `:359`.
- **`tailscale`**: `src/mcp/redirect.ts:70` (`tailscale status --json`), only when `--tailscale` or `ULTRATHINK_OAUTH_TAILSCALE=1` (`src/mcp/redirect.ts:164-166`). Used by the auth command, not by hooks.
- **Version probes** (`python`/`bun`/`claude`): `src/doctor/cli.ts:37-40`, `:56-59`. Triggered by the doctor command. Hook-triggered use is UNVERIFIED (check `src/doctor/` callers).

### (4) Environment

- **Read:**
  - `ULTRATHINK_HOST` (`src/host/detect.ts:18`; `hooks/engine.ts:69`).
  - `ULTRATHINK_STATE_DIR` (`src/host/paths.ts:58-61`).
  - `ULTRATHINK_UPLIFT` (`hooks/uplift.ts:87`); `ULTRATHINK_DEBUG` (`hooks/uplift.ts:42`).
  - `ULTRATHINK_DECISIONS` (`src/decisions/gate.ts:147-149`); `ULTRATHINK_DECISIONS_URL` (`src/decisions/client.ts:88`); `ULTRATHINK_OPENROUTER_KEY` (`src/decisions/gate.ts:63`).
  - `ULTRATHINK_MCP_STORE` (`src/mcp/store.ts:52`).
  - `CLAUDE_CONFIG_DIR` (`src/host/paths.ts:47`; `src/config.ts:1141`).
  - `XDG_CONFIG_HOME` (`src/config.ts:1127`; `src/mcp/store.ts:53`); `HOME`.
  - `BUN`, `BUN_INSTALL` (`bin/run-bun:14`, `:23`).
  - Detection: `GROK_*`, `MUSE_*`, `PRIME_AGENT_CODING_AGENT_DIR`, `RLM_SESSION_DIR` (`src/host/detect.ts:20-24`), used to rule out other hosts.
- **Set:**
  - `bin/run-bun` sets `PATH` and unsets `ULTRATHINK_BUN_REQUIRED` (`bin/run-bun:43-44`).
  - Teach observe child gets `ULTRATHINK_HOST` and `ULTRATHINK_STATE_DIR` (`src/teach/spawn.ts:116-120`).
  - Claude-code does not set `ULTRATHINK_HOST` (its default comes from detection).

### (5) Network

- **Decisions (OpenRouter Jev):** enabled by default (`src/decisions/types.ts:74-75`). Endpoint `https://openrouter.ai/api/alpha/decisions` (`src/decisions/types.ts:24`). Bearer auth (`src/decisions/client.ts:597`). Key from the credential store or `ULTRATHINK_OPENROUTER_KEY` only (`src/decisions/gate.ts:51-64`). Called from `src/claude/hook.ts:787`. Request payload contents UNVERIFIED (check `src/decisions/client.ts` request body builder).
- **Linear and Notion via MCP** (tracker): `https://mcp.notion.com/mcp` (`src/mcp/providers.ts:41`), `https://mcp.linear.app/mcp` (`src/mcp/providers.ts:52`). Gated: needs a `linear.team` or `notion.dataSourceUrl` (`src/track/gateway.ts:56-64`; defaults empty at `src/config.ts:107`, `:116`) and stored credentials (`src/mcp/client.ts:224-231`). Invoked from `hooks/uplift.ts:225`.
- **Greptile via MCP** (knowledge base): `https://api.greptile.com/mcp` (`src/mcp/providers.ts:63`). Off unless `hitl.knowledgeBase` is on (`src/hitl/types.ts:38`, default `false`; `src/greptile/knowledge.ts:511`). Called from `src/claude/hook.ts:935`.
- **Agent Substrate** (events and brief): POST `${url}/events` (`src/substrate/brief.ts:341`), bearer token. Off unless `substrate.url` is set (`src/config.ts:144-146`, default `""`). Brief fetched at `src/claude/hook.ts:877` (`fetchBrief` at `src/substrate/brief.ts:245`).
- **Grok HTTP** (only when a Grok route is selected): `https://cli-chat-proxy.grok.com/v1` (`src/grok/types.ts:56`). Default `transport: "http"` (`src/grok/types.ts:59`).
- **GitHub:** via `gh` (`src/ship/github.ts:239`).
- **Local listener** (auth command only): `http://127.0.0.1:<port>/callback` (`src/mcp/redirect.ts:121`).

### (6) Justifications

- Read `~/.config/ultrathink/config.json` and `~/.claude/ultrathink.json`: the layered config needs user-scope defaults (`src/config.ts:1124-1145`).
- Read `<cwd>/.claude/ultrathink.json`: per-project settings; cannot change spawn binaries (`src/config.ts:394`).
- Read the transcript path the host passes: the Stop hook summarizes the session for teach (`hooks/stop.ts:53`).
- Write the state directory: session, spec, carrier, and inbox files are the plugin's own state (`src/host/paths.ts:46-49`).
- Write `~/.config/ultrathink/mcp-credentials.json`: OAuth tokens for Linear, Notion, and Greptile; kept outside the state dir so the same login serves every host (`src/mcp/store.ts:51-55`). **Outside baseline.**
- Write `~/.claude/skills/`: promotes a lesson into a skill Claude Code can load; user-invoked only (`src/teach/promote.ts:451-452`). **Outside baseline.**
- Spawn `claude`: the planning engine (`src/claude/complete.ts:301-305`).
- Spawn `git` and `gh`: branch, PR, and CI state for tracking and ship (`src/track/git.ts:26-32`; `src/ship/github.ts:239`). **Outside baseline.**
- Network to Decisions, MCP, Substrate, Grok: each is an opt-in or default-on feature listed in §5. **Outside baseline.**

---

## 3. grok-build

**Surface:** `hooks/hooks.json` (entry, `adapters/cli.ts:70`). The adapter module is `adapters/grok-build/index.ts`. Detection: `GROK_PLUGIN_ROOT`, `GROK_HOOK_EVENT`, or `GROK_SESSION_ID` (`src/host/detect.ts:20-21`). The repo has no Grok plugin manifest. `.grok/` contains only `config.toml` (`.grok/config.toml:1-4`).

### (1) Files read

- Same hook inputs and config files as claude-code (§2 (1)), with `GROK_HOME` for the Grok auth file.
- Grok auth: `$GROK_HOME` or `~/.grok/auth.json` (`src/grok/auth.ts:63`, `:88`).
- `.grok/config.toml` in the repo declares a substrate MCP server with `url = "${SUBSTRATE_URL}/mcp"` and `Authorization: Bearer ${SUBSTRATE_TOKEN}` (`.grok/config.toml:2-4`). Whether Grok reads this file from the project root is UNVERIFIED (check the Grok CLI config loader).
- Adapter entry check: `hooks/hooks.json` existence (`adapters/cli.ts:196-198`; `adapters/grok-build/index.ts:73`).

### (2) Files written

- State directory: `$GROK_PLUGIN_DATA/ultrathink` if set, else `$GROK_HOME/plugin-data/ultrathink` (default `~/.grok/plugin-data/ultrathink`) (`src/host/paths.ts:23-27`). Same writes as §2 (2).
- Grok login config: `src/grok/login.ts:84-96` writes JSON with a `grok.home` key. The target path is UNVERIFIED (check the caller of this function in `src/grok/login.ts`).
- No project-root writes found.

### (3) Processes spawned

- `bin/run-bun` for hooks (`hooks/hooks.json`).
- `bin/ultrathink` via the adapter's runner (`adapters/cli.ts:202`; `:126-131`).
- Grok CLI: `grok models` for auth refresh (`src/grok/auth.ts:168`); planning via `src/grok/complete.ts:481-485`.
- Claude CLI on fallback (`src/host/engine.ts`, configured fallback, UNVERIFIED path cite; see §2 (3)).
- Detached `bin/ultrathink teach observe` (`src/teach/spawn.ts:122-128`).

### (4) Environment

- **Read:** `GROK_PLUGIN_ROOT`, `GROK_HOOK_EVENT`, `GROK_SESSION_ID` (`src/host/detect.ts:20`); `GROK_PLUGIN_DATA`, `GROK_HOME` (`src/host/paths.ts:24-26`; `src/grok/auth.ts:63`).
- **Read (passed to the Grok child):** `GROK_SUBAGENTS`, `GROK_MEMORY`, `GROK_WEB_FETCH` (`src/grok/complete.test.ts:472-473` shows the child env; the reader in production code is UNVERIFIED, check `src/grok/complete.ts` env construction).
- **Set:** none by the adapter (`adapters/cli.ts:70` has no `env` for grok-build). `bin/run-bun` and the teach child set `ULTRATHINK_HOST` / `ULTRATHINK_STATE_DIR` as in §2 (4).

### (5) Network

- Grok HTTP: `https://cli-chat-proxy.grok.com/v1` (`src/grok/types.ts:56`), default transport `http` (`src/grok/types.ts:59`).
- Decisions, MCP tracker, Greptile, and Substrate: same engine code as claude-code, same gates (§2 (5)).

### (6) Justifications

- Read `$GROK_HOME/auth.json`: the Grok CLI's OAuth session, needed for Grok planning (`src/grok/auth.ts:88`).
- Write the plugin data dir: the state directory the Grok host supplies (`src/host/paths.ts:23-27`).
- Write the Grok config `grok.home`: records which Grok home the plugin uses (`src/grok/login.ts:84-96`). Target path UNVERIFIED.
- Spawn `grok`: the Grok engine and auth refresh (`src/grok/complete.ts:481-485`; `src/grok/auth.ts:168`).
- Network to `cli-chat-proxy.grok.com`: the Grok engine transport (`src/grok/types.ts:56`). Only on a Grok route.

---

## 4. muse

**Surface:** `.muse-plugin/plugin.json` (manifest) and `hooks/muse-prompt`, `hooks/muse-post-tool`, `hooks/muse-stop` (entries, `adapters/cli.ts:71`).

### (1) Files read

- Muse hook stdin (Claude-shaped), via `sh` launchers: `.muse-plugin/plugin.json:64, 71, 78`.
- Shared config and session files, as §2 (1). `XDG_CONFIG_HOME` is read for the muse state dir (`src/host/paths.ts:34-35`).
- Muse-specific config env (`MUSE_CONFIG`, `MUSE_MODEL_DEFAULT`, `MUSE_EFFORTS`) appears in `src/config.ts` / `src/muse/` by grep; the exact read sites are UNVERIFIED (check `src/muse/types.ts` and `src/config.ts` loaders).
- Skill and command documents named in the manifest: `.muse-plugin/plugin.json:15-57`. Read by Muse, not by the plugin.

### (2) Files written

- State directory: `${XDG_CONFIG_HOME:-~/.config}/muse/ultrathink/` (`src/host/paths.ts:33-36`). Note this is not `~/.config/ultrathink/`; the MCP store stays in `~/.config/ultrathink/` (`src/mcp/store.ts:51-55`).
- Otherwise the same writes as §2 (2), including the `~/.config/ultrathink/mcp-credentials.json` store.
- Muse prompt file, written by the Muse CLI runner: `src/muse/complete.ts:128-130`, a temp file for the prompt.

### (3) Processes spawned

- `sh hooks/muse-prompt`, `sh hooks/muse-post-tool`, `sh hooks/muse-stop` (`.muse-plugin/plugin.json:64, 71, 78`). Each `exec`s `bin/run-bun` (`hooks/muse-prompt:11`, `hooks/muse-post-tool:10`, `hooks/muse-stop:10`).
- Muse CLI: `src/muse/complete.ts:137-141`, default `bin: "muse"` (`src/muse/types.ts:33`).
- Claude CLI, `git`, `gh`, detached teach observe: as §2 (3), on their respective routes.

### (4) Environment

- **Set:** `ULTRATHINK_HOST=muse` in each launcher (`hooks/muse-prompt:10`, `hooks/muse-post-tool:9`, `hooks/muse-stop:10`). The comments state that Muse hook argv cannot set env, so the launcher forces the host.
- **Read:** `MUSE_TOOL_USE_ID`, `MUSE_PLUGIN_ID` (`src/host/detect.ts:23`); `XDG_CONFIG_HOME` (`src/host/paths.ts:34`).
- **Read:** `MUSE_CONFIG`, `MUSE_MODEL_DEFAULT`, `MUSE_EFFORTS` (UNVERIFIED read sites; see §4 (1)).

### (5) Network

- The Muse launchers make no network calls. `hooks/muse-prompt` runs the Claude hook entry (`hooks/uplift.ts`, `hooks/muse-prompt:11`), so the engine network surface is the same as §2 (5).
- Muse CLI network is the Muse CLI's own (outside plugin code).

### (6) Justifications

- Set `ULTRATHINK_HOST=muse`: host detection cannot be inferred from Muse argv (`hooks/muse-prompt:6`), and the state dir depends on it (`src/host/paths.ts:33`).
- Write `${XDG_CONFIG_HOME}/muse/ultrathink/`: the state dir Muse uses (`src/host/paths.ts:33-36`).
- Spawn `sh` on the three launchers: the manifest's hook command form (`.muse-plugin/plugin.json:64`).
- Spawn `muse`: the Muse engine (`src/muse/complete.ts:137-141`).

---

## 5. hermes

**Surface:** `hosts/hermes/plugin.yaml` (manifest), `hosts/hermes/__init__.py` (registration), `hosts/hermes/bridge.py` (entry, `adapters/cli.ts:72`).

### (1) Files read

- `${HERMES_HOME:-~/.hermes}/config.yaml`, for `plugins.hook_callback_timeout` (`hosts/hermes/bridge.py:183-192`; parse `:209-248`). Read on the hook path only for timeout values.
- Engine entry existence: `hooks/engine.ts` and `bin/run-bun` (`hosts/hermes/bridge.py:50-53`, `:407-410`).
- Gateway session sender name via `gateway.session_context.get_session_env` (`hosts/hermes/bridge.py:313-321`).
- Hermes hook and tool payloads (Hermes-supplied, not read from disk).
- The engine itself reads the state dir (see §5 (2)).

### (2) Files written

- State directory: `${HERMES_HOME:-~/.hermes}/ultrathink/` (`hosts/hermes/bridge.py:477-487`; `src/host/paths.ts:29-32`). Engine writes as §2 (2).
- Teach inbox: `<state>/teach/inbox/<epoch>-<8hex>.json`, dir mode 0700, file mode 0600 (`hosts/hermes/bridge.py:977-985`).
- Does not write `~/.hermes/config.yaml` or `~/.hermes/skills`. `teach promote` for Hermes returns a draft and says ultrathink "never writes `~/.hermes/skills`" (`src/teach/promote.ts:12-14`, `:346`).

### (3) Processes spawned

- `bun` **directly** when `BUN` is set: `hosts/hermes/bridge.py:406`, `:419` (`command = [bun, ENGINE]`), `:422-433` (`subprocess.Popen`, new session). This bypasses `bin/run-bun`. Without `BUN`, the command is `bin/run-bun hooks/engine.ts` (`:419`).
- `bin/ultrathink-adapter hermes <verb> ... --raw` for the adapter verbs (`hosts/hermes/bridge.py:54`, `:56`, `:739-741`; subprocess at `:744-752`, timeout `CONTROL_TIMEOUT_S = 20` at `:62`).
- `bin/ultrathink` for other control verbs and teach (`hosts/hermes/bridge.py:741`; `:829-838` for `teach`).
- Detached `bin/ultrathink teach observe --file <inbox>` with `start_new_session=True` (`hosts/hermes/bridge.py:990-998`).
- Grandchildren (`claude`, `grok`, `muse`, `git`, `gh`) as in §2 (3). `_reap` sends SIGTERM then SIGKILL to the process group (`hosts/hermes/bridge.py:331-342`).

### (4) Environment

- **Set:** `ULTRATHINK_HOST=hermes` (`hosts/hermes/bridge.py:405`, `:809`); `ULTRATHINK_STATE_DIR` in the child env (`:809`).
- **Read:** `HERMES_HOME` (`hosts/hermes/bridge.py:188`, `:477-485`, `:1177`; `src/host/paths.ts:30`); `HERMES_SESSION_USER_NAME` (`:319`); `BUN` (`:406`); `ULTRATHINK_STATE_DIR` (`:478`); `ULTRATHINK_HOST` (`:809`).
- Hook cap envs in `bridge.py:60-61` are constants, not env.

### (5) Network

- None in `bridge.py`. Imports do not include `urllib`, `requests`, or `http` (grep: only a regex at `:90`).
- Engine network (Decisions, MCP tracker, Greptile, Substrate) applies through `hooks/engine.ts`, which calls the same planning path (`hooks/engine.ts:73`). Same gates as §2 (5).

### (6) Justifications

- Read `${HERMES_HOME}/config.yaml`: honors Hermes' own hook cap so the plugin does not outlive it (`hosts/hermes/bridge.py:18-21`).
- Write `${HERMES_HOME}/ultrathink/`: the state directory Hermes uses (`src/host/paths.ts:29-32`).
- Write the teach inbox at 0600 in a 0700 dir: session digests contain verbatim prompts (`hosts/hermes/bridge.py:977-985`).
- Spawn `bun` directly when `BUN` is set: an explicit operator override (`hosts/hermes/bridge.py:406`). **Outside the allowlist's literal form.**
- Spawn `bin/ultrathink-adapter` and `bin/ultrathink`: the allowlisted launchers (`hosts/hermes/bridge.py:739-752`).
- Detached `teach observe`: lets the Stop-equivalent hook return within Hermes' budget (`hosts/hermes/bridge.py:990-998`).

---

## 6. prime-agent

**Surface:** `hosts/prime-agent/SKILL.md` (manifest and entry, `adapters/cli.ts:73-77`). Prime Agent has no prompt hook (`hosts/prime-agent/SKILL.md:10`). The CLI adapter exposes the same six verbs. The adapter sets `ULTRATHINK_HOST=prime-agent` (`adapters/cli.ts:76`).

### (1) Files read

- Config: `~/.config/ultrathink/config.json`, `~/.claude/ultrathink.json`, `<project>/.claude/ultrathink.json` (`hosts/prime-agent/SKILL.md:54`; `src/config.ts:1124-1145`).
- `cwd` argument selects the project config layer and skill lookup (`hosts/prime-agent/SKILL.md:25`).
- Last-plan carrier `last-plan.<session>.json` (`hosts/prime-agent/SKILL.md:48`).
- Teach lessons and skills: `~/.prime/agent/skills/` read only through Prime (`hosts/prime-agent/SKILL.md:49-50`).
- Adapter entry existence: `hosts/prime-agent/SKILL.md` (`adapters/prime-agent/index.ts:88`; `adapters/cli.ts:196-198`).

### (2) Files written

- State directory: `${PRIME_AGENT_CODING_AGENT_DIR:-~/.prime/agent}/ultrathink/` (`hosts/prime-agent/SKILL.md:11`; `src/host/paths.ts:42-45`). Writes as §2 (2), including `last-plan.<session>.json` (`hosts/prime-agent/SKILL.md:48`).
- Skills on `teach promote --install`: `${PRIME_AGENT_CODING_AGENT_DIR:-~/.prime/agent}/skills/<name>/SKILL.md` (`src/teach/promote.ts:447-449`). User-invoked.
- Mcp credentials at `~/.config/ultrathink/mcp-credentials.json` (`src/mcp/store.ts:51-55`).

### (3) Processes spawned

- `bin/ultrathink <verb>` through the runner (`adapters/cli.ts:202`). The Prime kernel calls `ultrathink(...)` or the shell form `ultrathink "request" --force` (`hosts/prime-agent/SKILL.md:15-27`). The mechanism by which the Prime kernel spawns the CLI is UNVERIFIED (check Prime Agent's skill runner).
- Engine children (`claude`, `grok`, `muse`) as §2 (3). On cancel, Prime sends SIGTERM to the engine process group, then SIGKILL after a grace period (`hosts/prime-agent/SKILL.md:26`).

### (4) Environment

- **Set:** `ULTRATHINK_HOST=prime-agent` (`adapters/cli.ts:76`).
- **Read:** `PRIME_AGENT_CODING_AGENT_DIR`, `RLM_SESSION_DIR` (`src/host/detect.ts:24`; `src/host/paths.ts:43`); `ULTRATHINK_STATE_DIR` (`src/host/paths.ts:58`); `BUN` (`bin/run-bun:14`).
- **Documented in SKILL.md but not confirmed in code:** `ULTRATHINK_PLUGIN_ROOT` (`hosts/prime-agent/SKILL.md:4, 55`), `ULTRATHINK_SESSION_ID` (`:55`), `ULTRATHINK_UPLIFT=0` (`:55`; the reader is `hooks/uplift.ts:87`, which Prime does not run). The readers for `ULTRATHINK_PLUGIN_ROOT` and `ULTRATHINK_SESSION_ID` are UNVERIFIED (check `src/uplift/commands.ts`).

### (5) Network

- Same engine surface as §2 (5), reached via `bin/ultrathink`.
- The SKILL states that tracking needs `bin/ultrathink-mcp auth login linear|notion` (`hosts/prime-agent/SKILL.md:56`).

### (6) Justifications

- Set `ULTRATHINK_HOST=prime-agent`: detection cannot infer Prime from argv alone (`src/host/detect.ts:17-26`).
- Read the three config files: same layered config as the other hosts (`hosts/prime-agent/SKILL.md:54`).
- Write `${PRIME_AGENT_CODING_AGENT_DIR}/ultrathink/`: the Prime state directory (`src/host/paths.ts:42-45`).
- Write `~/.prime/agent/skills/`: lesson promotion, user-invoked (`src/teach/promote.ts:447-449`). **Outside baseline.**
- Cancel with SIGTERM/SIGKILL to the process group: prevents orphaned model CLIs (`hosts/prime-agent/SKILL.md:26`).

---

## Permissions outside the core baseline

Consolidated from §§1–6. Each item is a permission the code uses that the baseline (read project; write project root and state dir; no core network; spawn allowlist only) does not cover.

### Writes outside the state dir and project root

| Path | Written by | Evidence |
|---|---|---|
| `~/.config/ultrathink/mcp-credentials.json` (0600, dir 0700) | MCP store | `src/mcp/store.ts:51-55`, `:133-140` |
| `~/.claude/skills/<name>/SKILL.md` | `teach promote --install` (claude) | `src/teach/promote.ts:451-452`, `:318` |
| `~/.prime/agent/skills/<name>/SKILL.md` | `teach promote --install` (prime-agent) | `src/teach/promote.ts:447-449` |
| Grok config (`grok.home`) | `grok login` path | `src/grok/login.ts:84-96` (target UNVERIFIED) |
| Any path set by `ULTRATHINK_STATE_DIR` | Engine, all hosts | `src/host/paths.ts:55-61`: only `.planning` paths are refused; any other directory is accepted |

### Reads outside the project root

| Path | Read by | Evidence |
|---|---|---|
| `~/.config/ultrathink/config.json`, `$CLAUDE_CONFIG_DIR/ultrathink.json`, `~/.claude/ultrathink.json` | Config loader | `src/config.ts:1124-1145` |
| `~/.config/ultrathink/mcp-credentials.json` | MCP client | `src/mcp/store.ts:51-55`; `src/mcp/client.ts:224-231` |
| `~/.grok/auth.json` / `$GROK_HOME/auth.json` | Grok auth | `src/grok/auth.ts:63`, `:88` |
| `${HERMES_HOME}/config.yaml` | Hermes bridge | `hosts/hermes/bridge.py:183-192` |
| Host-supplied transcript path | Stop hook | `hooks/stop.ts:53` |

### Network from core (not covered by "no network in core")

| Destination | Trigger and gate | Evidence |
|---|---|---|
| `https://openrouter.ai/api/alpha/decisions` (Decisions/Jev) | Default on; needs a key from the store or `ULTRATHINK_OPENROUTER_KEY` | `src/decisions/types.ts:24`, `:74-75`; `src/decisions/gate.ts:51-64`; `src/decisions/client.ts:597`; `src/claude/hook.ts:787` |
| `https://mcp.linear.app/mcp`, `https://mcp.notion.com/mcp` (tracking) | Needs `linear.team` or `notion.dataSourceUrl` and stored credentials | `src/mcp/providers.ts:41`, `:52`; `src/track/gateway.ts:56-64`; `src/config.ts:107`, `:116`; `hooks/uplift.ts:225` |
| `https://api.greptile.com/mcp` (knowledge base) | Off by default (`hitl.knowledgeBase: false`); needs credentials | `src/mcp/providers.ts:63`; `src/hitl/types.ts:38`; `src/greptile/knowledge.ts:507-519`; `src/claude/hook.ts:935` |
| `${substrate.url}/events`, brief fetch (bearer token) | Off by default (`url: ""`) | `src/substrate/brief.ts:341`, `:245`; `src/config.ts:144-146`; `src/claude/hook.ts:877` |
| `https://cli-chat-proxy.grok.com/v1` | Grok route only; default transport `http` | `src/grok/types.ts:56`, `:59` |
| GitHub API via `gh` | Ship path only | `src/ship/github.ts:239`, `:340`, `:359` |
| `127.0.0.1` loopback listener (OAuth callback) | Auth command only | `src/mcp/redirect.ts:121` |
| Tailscale serve | `--tailscale` or `ULTRATHINK_OAUTH_TAILSCALE=1` only | `src/mcp/redirect.ts:70`, `:164-166` |

### Process spawns outside the allowlist

| Process | Trigger | Evidence |
|---|---|---|
| `claude` | Claude engine (default) | `src/claude/complete.ts:301-305`; `src/config.ts:89` |
| `grok` (`models`, planning, login) | Grok route; auth refresh | `src/grok/complete.ts:481-485`; `src/grok/auth.ts:168`; `src/grok/login.ts:49-54`; `src/grok/types.ts:60` |
| `muse` | Muse route | `src/muse/complete.ts:137-141`; `src/muse/types.ts:33` |
| `git` | Tracking, ship | `src/track/git.ts:26-32` |
| `gh` | Ship | `src/ship/github.ts:239`, `:340`, `:359` |
| `tailscale` | Opt-in OAuth route | `src/mcp/redirect.ts:70` |
| version probes (`python`, `bun`, `claude`) | Doctor command | `src/doctor/cli.ts:37-40`, `:56-59` |
| `bun` directly (not through `run-bun`) | Hermes, when `BUN` is set | `hosts/hermes/bridge.py:406`, `:419` |
| Model CLIs as grandchildren of `bin/ultrathink` | Engine | `src/resilience/child.ts:123-126` |

Allowlisted launchers used as intended: `bin/run-bun` (`hooks/hooks.json`), `bin/ultrathink` (`adapters/cli.ts:202`, `src/teach/spawn.ts:125`), `bin/ultrathink-adapter` (`hosts/hermes/bridge.py:739-741`). The teach-observe supervisor is launched through `bin/run-bun` and runs `bin/ultrathink` (`src/teach/spawn.ts:25-27`, `:122-128`).

### Environment exposure

- `adapters/cli.ts:177`: the child engine receives the full `process.env` merged with the host `env`. No allowlist of variables. This includes `OPENROUTER_API_KEY`-style variables. The engine's own handling (`src/decisions/gate.ts:47-50`) refuses the generic `OPENROUTER_API_KEY` but other secrets are passed through.
- `src/teach/spawn.ts:116-120`: the teach-observe child inherits `options.env` and adds two variables.
- `bin/run-bun:48`: `--no-env-file` prevents `.env*` loading by Bun. This is the one env-isolation control in the path.

### Commands referenced by instructions (not spawned by plugin code)

- `bin/ultrathink-mcp track complete` (`src/track/gateway.ts:159-162`), injected into the prompt as an instruction for the agent to run. The agent's own shell permission applies, not the plugin's.
- `bin/ultrathink-ship` (`src/ship/nudge.ts:14`, `:44`), injected as an instruction.
- `bin/ultrathink-mcp auth login` (`hosts/prime-agent/SKILL.md:56`), user-run.

These are not in the spawn allowlist as written in the brief. Adding them would need an explicit decision.

### Recorded decisions

- **D1. MCP credentials file: intentional exception, not opt-in.**
  - Path: `~/.config/ultrathink/mcp-credentials.json` (row at line 340; see Core baseline D1).
  - Reason: it is the user's own config directory, and moving it would break MCP auth (UNVERIFIED (check `src/mcp/client.ts:224-231`) for the MCP auth consequence; line 143 supports only the cross-host part).
  - Enforcing file: none cited. The path is defined at `src/mcp/store.ts:51-55`; no opt-in gate is cited in this document.
- **D2. `teach promote --install`: opt-in exception.**
  - Writes: `~/.claude/skills/<name>/SKILL.md` (`src/teach/promote.ts:451-452`) and `~/.prime/agent/skills/<name>/SKILL.md` (`src/teach/promote.ts:447-449`); see rows at lines 341-342.
  - Reason: the user must choose it.
  - Opt-in: the explicit `--install` flag.
  - Enforcing file: `src/teach/promote.ts`. The line that checks `--install` is UNVERIFIED (check the flag handling in `src/teach/promote.ts`; not cited in this document).

---

## UNVERIFIED register

| Claim | Check |
|---|---|
| Claude Code discovers `hooks/hooks.json` by convention (no hook declaration in `.claude-plugin/plugin.json`) | Claude Code plugin loader docs / the host's manifest schema |
| Decisions request payload contents (what is sent to OpenRouter) | `src/decisions/client.ts` request body builder |
| Grok reads `.grok/config.toml` from the project root | Grok CLI config loader |
| Grok login config write target (`src/grok/login.ts:84-96`) | Caller of that function in `src/grok/login.ts` |
| `GROK_SUBAGENTS`, `GROK_MEMORY`, `GROK_WEB_FETCH` readers in production code | `src/grok/complete.ts` env builder |
| `MUSE_CONFIG`, `MUSE_MODEL_DEFAULT`, `MUSE_EFFORTS` read sites | `src/muse/types.ts`, `src/config.ts` loaders |
| `ULTRATHINK_PLUGIN_ROOT`, `ULTRATHINK_SESSION_ID`, and `ULTRATHINK_UPLIFT` as read by the Prime control path | `src/uplift/commands.ts` |
| Ship writes project files (commits, branch) and the set of repo writes | `src/ship/` git commit paths |
| `doctor` probes are never hook-triggered | `src/doctor/` callers |
| Target of `defaultStorePath` used by `hooks/flow-eval.ts:111` | Definition of `defaultStorePath` (not found by grep in `src/` or `hooks/`) |
| `src/retention/prune.ts` deletion scope (`unlinkSync` at `:537`) | Its directory list (the scope of files it removes) |
| `src/teach/store.ts`, `src/teach/runlog.ts`, `src/teach/activity.ts` write under the state dir | Each file's root path argument |
| Prime Agent kernel spawns the CLI as `bin/ultrathink` | Prime Agent skill runner |
| Muse prompt temp file location (`src/muse/complete.ts:128-130`) | The `promptFile` argument's origin |
| `hooks/answers.ts:57` writes under the state dir | `xmlPath` derivation in `hooks/answers.ts` |

---

## Out of scope but present

- **Adapter `omp`:** `adapters/omp/README.md` exists and `src/host/paths.ts:38-41` defines an `omp` state dir (`~/.omp/agent/ultrathink`). It is not in `HOSTS` (`adapters/cli.ts:68-78`) and was not reviewed.
- **Cursor:** `src/host/paths.ts:50-51` (`~/.cursor/ultrathink`), not in `HOSTS`.
- **Bins outside the five hosts:** `bin/ultrathink-grokbot` (`src/host/grokbot-cli.ts`, calls `https://api.github.com` at `:180`, sets `ULTRATHINK_SHIP=0` at `:287`), `bin/ultrathink-connector`, `bin/ultrathink-mcp`, `bin/ultrathink-ship`. Each would need its own section if it is to be covered by the model.
- **Swarm lanes:** `src/swarm/lane.ts` spawns lane processes (`spawnLanes`, `spawnGuarded`, referenced from `src/host/omp.ts:84-86`). Only reached from the omp host.
