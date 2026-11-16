# GSD-Core findings

Research date: 2026-11-16. Scope: what GSD-Core installs, for which CLI agents, how, and what it leaves in `.planning/`.
Every claim cites a file:line or URL. Anything not read directly is marked ASSUMPTION or UNVERIFIED.

Short source names used below:

- `UP:` = `https://raw.githubusercontent.com/open-gsd/gsd-core/main/<path>` (upstream `main`, read 2026-11-16; `package.json` there says version 1.21.0).
- `LOCAL:` = `/root/.agents/gsd-core/<path>` (local copy; `VERSION` says 1.18.0, `.gsd-runtime` says `kimi`).
- `INSTALL.js` = `UP:bin/install.js` (756 KB single file, line numbers are for `main` on the read date).

## 1. Project identity

- npm package `@opengsd/gsd-core`, version 1.21.0, MIT, `engines.node >=24.0.0` (UP:package.json). Bins: `gsd-core` (the installer, `bin/install.js`), `gsd-tools`, `gsd_run`, `gsd-mcp-server` (UP:package.json `bin`).
- Repo: https://github.com/open-gsd/gsd-core. The old repo https://github.com/gsd-build/get-shit-done is an archived redirect whose README says "GSD Has Moved" and points at open-gsd/gsd-core (fetched 2026-11-16).
- Version skew: UP is 1.21.0 and LOCAL is 1.18.0. UP README still says "What's new in 1.7.0" (UP:README.md), so README text lags the code. Treat INSTALL.js and the capability docs as the authority.
- Quickstart: `npx @opengsd/gsd-core@latest`; the installer prompts for runtime and global/local scope (UP:README.md, UP:docs/how-to/install-on-your-runtime.md).
- Rule from the docs: "Do not copy files from `agents/` or `commands/` directly". Source files are in Claude Code frontmatter and each runtime needs transformed output (UP:docs/how-to/install-on-your-runtime.md, "Why the installer is required").

## 2. Supported runtimes (installer truth)

`--all` selects 18 runtimes (INSTALL.js:1101-1104): `claude, kimi, kimi-code, kilo, opencode, pi, codex, copilot, antigravity, cursor, windsurf, augment, trae, qwen, hermes, codebuddy, cline, zcode`. The interactive list `allRuntimes` has the same 18 (INSTALL.js:14503).

Per-runtime flags: `--claude --opencode --pi --kilo --codex --copilot --antigravity --cursor --windsurf --augment --trae --qwen --hermes --kimi --kimi-code --codebuddy --cline --zcode` (INSTALL.js:1111-1127). `--devin-desktop` is documented as an alias of `--windsurf` (UP:docs/how-to/install-on-your-runtime.md, Windsurf section). `--both` also exists (INSTALL.js:1105; meaning not read, ASSUMPTION: claude+opencode).

Removed runtime: `--gemini` is refused; the installer prints that Gemini CLI was sunset on 2026-06-18 and tells users to use `--antigravity` (INSTALL.js:1214-1217).

Local alias manifest (LOCAL:bin/shared/runtime-aliases.manifest.json) lists only 16 runtimes. `pi` and `zcode` are absent. Cause is probably the 1.18.0 vs 1.21.0 skew (ASSUMPTION). Aliases per runtime include `claude-code`, `claude-cli`, `open-code`, `codex-desktop`, `github-copilot`, `devin-desktop` (windsurf), `augment-code`, `qwen-code`, `hermes-agent`, `kimicode`, `kimi_code` (same file).

### Installer flags (INSTALL.js:1042-1386)

| Flag | Effect (as far as read) |
|---|---|
| `--global`/`-g`, `--local`/`-l` | Scope (INSTALL.js:1043-1044) |
| `--uninstall`/`-u` | Remove GSD from the chosen runtime and scope (INSTALL.js:1045, `uninstall()` at 8661) |
| `--config-dir <path>` | Override the config root (INSTALL.js:1366-1384) |
| `--dry-run` | INSTALL.js:1049; behavior beyond the flag read is UNVERIFIED |
| `--minimal`/`--core-only`, `--profile=<name[,name]>` | Smaller artifact surface; mutually exclusive (INSTALL.js:1048, 1080-1082). Uninstall removes the `.gsd-profile` marker (inside `uninstall()`, INSTALL.js:8661 onward, see section 6) |
| `--portable-hooks` (or `GSD_PORTABLE_HOOKS=1`) | `$HOME`-relative hook paths and a runtime node resolver (UP:docs/how-to/install-on-your-runtime.md, "Sharing one config root") |
| `--relative-includes` (or `GSD_RELATIVE_INCLUDES=1`) | Local installs only; emits project-relative `@` includes (INSTALL.js:1050-1068) |
| `--skills-root`, `--force-statusline`, `--no-legacy-cleanup`, `--reclaim-kimi-legacy`, `--help`/`-h` | INSTALL.js:1046, 1386, 1362-1363, 1079, 1385 |

Config dir env vars (UP:docs/USER-GUIDE.md:964-980): `CLAUDE_CONFIG_DIR`, `OPENCODE_CONFIG_DIR`, `COPILOT_CONFIG_DIR` (or `COPILOT_HOME`), `CURSOR_CONFIG_DIR`, `WINDSURF_CONFIG_DIR`, `ANTIGRAVITY_CONFIG_DIR`, `AUGMENT_CONFIG_DIR`, `TRAE_CONFIG_DIR`, `QWEN_CONFIG_DIR`, `KILO_CONFIG_DIR`, `CODEBUDDY_CONFIG_DIR`, `CLINE_CONFIG_DIR`; Codex uses `--config-dir` there. Other docs add `KIMI_CONFIG_DIR`, `KIMI_SHARE_DIR`, `KIMI_CODE_HOME`, `PI_CODING_AGENT_DIR` (UP:docs/how-to/install-on-your-runtime.md). Prerelease editions (Windsurf Next, Cursor Nightly, ...) are not separate runtimes; set the env var to the sibling dir (same doc).

## 3. Per-runtime command, skill, agent and hook mechanism

Root table is UP:docs/ARCHITECTURE.md:1039-1062 ("Runtime Install Contract Matrix"). Pi, Kimi Code and ZCode are not in that table; they come from UP:docs/how-to/install-on-your-runtime.md and UP:docs/reference/host-integration-capability-matrix.md (called MATRIX below).

| Runtime | Global root | Local root | Invocation surface | Agents | Hooks / config |
|---|---|---|---|---|---|
| claude | `~/.claude` | `./.claude` | Global `skills/gsd-*/SKILL.md` (flat); local `commands/gsd/*.md` per ARCHITECTURE (note INSTALL.js:10293 comment says local writes flat `gsd-*.md` since #1367; docs disagree, UNVERIFIED which is current). Plugin form: `/gsd-core:gsd-<cmd>` | `agents/gsd-*.md` | `settings.json` hooks + statusLine; also `.claude-plugin/plugin.json` + `hooks/hooks.json` native plugin path |
| opencode | `~/.config/opencode` (XDG) or `~/.opencode` | `./.opencode` | `commands/gsd-*.md` plus `skills/gsd-*/SKILL.md` | `agents/gsd-*.md` with `permission:` block | `opencode.json(c)`; native plugin `plugins/gsd-core.js` bridges `tool.execute.before/after`, `session.created`, `file.edited` to GSD hook scripts (opencode `hooksSurface: none`) |
| kilo | `~/.config/kilo` or `~/.kilo` | `./.kilo` | `command/gsd-*.md` + skills | `agents/gsd-*.md` | `kilo.json(c)`; ARCHITECTURE says no GSD hooks; the install doc lists only commands, agents, skills (no plugin file) |
| kimi (legacy `kimi-cli`) | first existing of `~/.config/agents`, `~/.agents` (skills root) | local deferred and guarded | `skills/gsd-*/SKILL.md`, invoked `/skill:gsd-*` | `agents/gsd.yaml` + `gsd.md`, `agents/subagents/gsd-*.{yaml,md}`; launch with `kimi --agent-file <root>/agents/gsd.yaml` | `[[hooks]]` in `~/.kimi/config.toml` between `# GSD Hooks BEGIN/END` markers; Beta in Kimi |
| kimi-code | skills root via `--config-dir`/`KIMI_CONFIG_DIR`; hooks root `~/.kimi-code` (`KIMI_CODE_HOME`) | n/a | Agent Skills only, `/skill:gsd-*` | none (MATRIX: `namedDispatch` false, GSD installs skills only) | `[[hooks]]` in `~/.kimi-code/config.toml`; own runtime since 1.10.0 (#2755); does not accept `--agent-file`, use `--skills-dir` |
| codex | `~/.codex` | `./.codex` | `skills/gsd-*/SKILL.md` | standalone `agents/gsd-*.toml`, auto-discovered, sole role registration (#2406) | `config.toml` `[agents] max_depth`, `[features].hooks`, `SessionStart` hook only; needs Codex CLI >= 0.130.0 (skills) and >= 0.137.0 (hooks) |
| copilot | `~/.copilot` | `./.github` | `skills/gsd-*/SKILL.md`, `copilot-instructions.md`, repo-root `AGENTS.md` (local) | `.agent.md` files | one inline `sessionStart` hook in `hooks/gsd-session.json` (global) or `.github/hooks/gsd-session.json` (local); advisory only |
| antigravity | auto-detected `~/.gemini/antigravity`, `-ide`, `-cli` | `./.agent` | `~/.gemini/config/skills/gsd-*/SKILL.md` (flat) | `~/.gemini/config/agents/gsd-*.md` | Gemini-style `settings.json` hooks |
| cursor | `~/.cursor` | `./.cursor` | `skills/gsd-*/SKILL.md` (flat; older `commands/gsd-*.md` copies are removed on upgrade) | `agents/gsd-*.md` | rule references under `rules/`; `hooks.json` with `sessionStart` and a `postToolUse` STATE.md monitor |
| windsurf / devin-desktop | `~/.codeium/windsurf` | `./.windsurf` | `workflows/gsd-*.md` (local only; global workflow install is a deliberate no-op) | none | none (ARCHITECTURE) |
| augment | `~/.augment` | `./.augment` | `skills/gsd-ns-*/SKILL.md` routers + nested `skills/<name>/SKILL.md`; also `commands/` | `agents/gsd-*.md` | `settings.json` `hooks` block and `mcpServers.gsd` (install doc) vs "No GSD hooks" (ARCHITECTURE); conflict, UNVERIFIED |
| trae | `~/.trae` | `./.trae` | namespaced router skills | `agents/gsd-*.md` | rule references only |
| qwen | `~/.qwen` | `./.qwen` | namespaced router skills, numeric `priority` frontmatter | `agents/gsd-*.md` (`name`/`description`/`tools:` YAML list) | settings hooks: SessionStart, PreToolUse, PostToolUse, Stop, PreCompact, SubagentStart/Stop |
| hermes | `~/.hermes` | `./.hermes` | `skills/gsd/ns-*/SKILL.md` routers (prefix `''`) + nested | `agents/gsd-*.md` | "common GSD settings and hook entries where supported" |
| codebuddy | `~/.codebuddy` | `./.codebuddy` | `commands/gsd-*.md` slash commands; skills emitted `user-invocable: false` | `agents/gsd-*.md` | `settings.json` hooks, Claude event dialect, 7 event types |
| cline | `~/.cline` | project root | skills under `~/.cline/skills/<name>/SKILL.md` (global only) + `.clinerules/gsd.md`; no slash commands | rules only | `.clinerules/hooks/PreToolUse` (macOS/Linux only), fails open; marker block in `~/.agents/AGENTS.md` |
| zcode | `~/.zcode` | n/a (not stated) | `skills/gsd-<name>/SKILL.md` (`$gsd-<name>`), `commands/gsd-<name>.md` (`/gsd-<name>`) | `agents/gsd-<name>.md` | hooks and MCP registration not wired (ZCode has not published the formats) |
| pi | `~/.pi/agent` (`PI_CODING_AGENT_DIR`) | `.pi` | `skills/gsd-<cmd>/SKILL.md` as `/skill:gsd-<cmd>`; `/gsd` command; `gsd_invoke` tool | none (`namedDispatch` undocumented; agent steps fail closed) | single extension `extensions/gsd.js`; bridges `session_start`, `before_agent_start`, `session_before_compact`, `tool_call` to `gsd-hooks/` scripts; no settings hook bus |

Sources for rows: UP:docs/ARCHITECTURE.md:1039-1062; UP:docs/how-to/install-on-your-runtime.md (sections per runtime); UP:docs/USER-GUIDE.md:51 (nested layout only for Cline, Qwen, Hermes, Augment, Trae; Antigravity and Claude are flat). Claude's `--global` plus `--local` coexistence: global skill wins `/gsd-<name>`; the installer warns, and `/gsd-health` shows diagnostic `W028` (install doc, Claude section).

Hook scripts shipped (UP:docs/ARCHITECTURE.md:294-298 and install doc tables): `gsd-check-update.js`, `gsd-session-state.sh`, `gsd-context-monitor.js`, `gsd-read-injection-scanner.js`, `gsd-phase-boundary.sh`, `gsd-graphify-update.sh`, `gsd-prompt-guard.js`, `gsd-read-guard.js`, `gsd-workflow-guard.js`, `gsd-worktree-path-guard.js`, `gsd-agent-isolation-guard.js`, `gsd-secret-read-guard.js`, `gsd-validate-commit.sh`, `gsd-config-reload.js` (Claude `FileChanged`). None of them is a prompt-submit gate; they are advisory or per-tool guards.

## 4. How the installer transforms Claude-format commands

The pipeline is one `convert*` family per runtime in INSTALL.js. Each starts with `filterRuntimeNotesForTarget(content, '<runtime>')` (INSTALL.js:2548, 2680, 2809, 2936, 4007, 7528, 7717) so runtime-specific notes survive only for their target.

| Runtime | Functions (INSTALL.js line) | What changes |
|---|---|---|
| claude | `convertClaudeCommandToClaudeSkill` 2169 | command to `SKILL.md` with skill frontmatter |
| opencode | `convertToolName` 1828, `convertClaudeToOpencodeFrontmatter` 7526 | `AskUserQuestion` becomes `question`; tool names mapped; agent `tools:` line removed; colors to hex (also USER-GUIDE.md:915-920) |
| kilo | `convertClaudeToKiloPermissionTool` 1978, `convertClaudeToKiloFrontmatter` 7715 | same idea as OpenCode, plus permission-style tool grants |
| kimi | `convertKimiToolName` 1899, `convertGsdCommandReferencesToKimiSkillInvocations` 2250, `convertClaudeCommandToKimiSkill` 2270 | `/gsd-x` references rewritten to `/skill:gsd-x`; `mcp__*` tools dropped |
| antigravity | `convertAntigravityToolName` 1848, `convertClaudeToAntigravityContent` 2547, `convertClaudeCommandToAntigravitySkill` 2590 | `mcp__*` tools dropped; global paths moved to `~/.gemini/config/skills` (#3738) |
| copilot | `convertCopilotToolName` 2022, `convertClaudeToCopilotContent` 2046, `convertClaudeCommandToCopilotSkill` 2076, `convertClaudeAgentToCopilotAgent` 2508 | `mcp__context7__*` to `io.github.upstash/context7/*`; `~/.claude` paths replaced |
| cursor | `convertClaudeToCursorMarkdown` 2679, `...ToCursorSkill` 2729, `...ToCursorAgent` 2755 | `Bash(` to `Shell(`; slash commands to skill mentions |
| trae | `convertClaudeToTraeMarkdown(Body)` 2800-2808, skill 2889, agent 2915 | `Bash(` to `Shell(`, `Edit(` to `StrReplace(`; slash to skill mentions |
| codebuddy | `convertClaudeToCodebuddyMarkdown` 2935, skill 2954, command 2990, agent 3011 | no tool renames (CodeBuddy uses Claude tool names); slash to skill mentions |
| cline | `convertClaudeAgentToClineAgent` 3050, `convertClaudeCommandToClineSkill` 3070 | rules plus skills |
| hermes | `convertClaudeToHermesMarkdown` 3929 | branding rewrites from `hostBehaviorsFor(runtime).brandingRewrites` |
| pi | `convertClaudeToPiMarkdown` 3964 | dispatch-tool config; fail-closed agent-step contract |
| codex | `convertClaudeToCodexMarkdown` 4006, skill 4170, agent 4192 | `$ARGUMENTS` to `{{GSD_ARGS}}`; `/clear` references removed; agents emitted as TOML |
| qwen, augment, windsurf, zcode | not located in the grep output | UNVERIFIED. ZCode needs none (skill format identical to Claude's, install doc) |

Install-time-only config: `agent_tools`, `model_overrides` and similar are baked into generated artifacts at install; the Claude native-plugin path does not apply them (install doc, "Install-time config does not apply here"; UP:docs/CONFIGURATION.md:203-230).

Split-brain risk for this repo: any Ultrathink command file we ship is a normal Claude-format file and must go through these same rules; we cannot rely on GSD's converters, since they only process GSD's own `commands/` and `agents/` (UP:docs/how-to/install-on-your-runtime.md). [INFERENCE]

## 5. Install artifacts and manifests

- The installer records a manifest of what it wrote. On update it compares file hashes; modified files are backed up to `gsd-local-patches/` and replaced, then `/gsd-update --reapply` restores them (UP:docs/how-to/update-gsd.md:137-140).
- `gsd-install-state.json` records `hostGeneration` for OpenCode (UP:docs/ARCHITECTURE.md, OpenCode 1.x and 2.x).
- Payload dir: `<configRoot>/gsd-core/` holds the engine, templates and workflows. The local copy at `/root/.agents/gsd-core/` has `agents/` (each agent in full `*.md` and `*.compact.md` form), `commands/gsd/*.md`, `workflows/` (plus `workflows/<name>/steps/`), `bin/gsd-tools.cjs`, `bin/shared/{config-schema,config-defaults,runtime-aliases}.manifest.json` and `model-catalog.json`. Those agent files still use Claude-form paths and commands (`~/.claude/gsd-core/templates/state.md`, `/gsd:plan-phase` at LOCAL:agents/gsd-roadmapper.md:49,453), so this payload tree is the untransformed source, not the runtime-converted output [INFERENCE: the converted per-runtime artifacts sit outside this dir].
- Hook scripts are staged under `hooks/` (or `gsd-hooks/` for pi, because pi warns when `hooks/` exists, #3023).

## 6. Uninstall behavior

`node bin/install.js --<runtime> --global|--local --uninstall`, or `npx @opengsd/gsd-core@latest --<runtime> --uninstall`; `uninstall(isGlobal, runtime)` is INSTALL.js:8661.

- Target dir: global config dir, project root for Cline-local, else `<cwd>/<dirName>`. A missing dir prints "Nothing to uninstall." (inside `uninstall()`, INSTALL.js:8661 onward).
- First recovers user artifacts orphaned by a crashed prior uninstall (#2875) and removes the `.gsd-profile` marker (same function; exact lines not captured).
- Removes GSD commands/skills/agents layout-driven, the `gsd-core/` payload, and hook registrations. Docs: "All registered hooks are managed by GSD and are removed cleanly on `--uninstall`" (install doc, Codex, Kimi, Qwen, CodeBuddy, Copilot sections).
- Marker-delimited blocks are stripped and surrounding user content kept: Codex `config.toml` (`stripGsdFromCodexConfig`, INSTALL.js:4796), Copilot instructions (7051), `AGENTS.md` (7092, deleted only when it was GSD-only), Cline's `~/.agents/AGENTS.md`, Kimi `# GSD Hooks BEGIN/END`.
- Hand-written `[[hooks]]` and unknown user command files are preserved (install doc, Kimi and Cursor sections).
- Local Copilot `AGENTS.md` cleanup runs before the missing-dir early return (comment #786 in `uninstall()`, INSTALL.js:8661 onward).
- `--gemini --uninstall` prints the sunset notice (INSTALL.js:1218).
- NOT verified: whether uninstall is transactional if it fails midway beyond the #2875 recovery pass, and what `--dry-run` prints.

## 7. `.planning/` artifact layout

All state is human-readable Markdown/JSON, no database (UP:docs/ARCHITECTURE.md:62-64, 87-90).

```
.planning/
  PROJECT.md  REQUIREMENTS.md  ROADMAP.md  STATE.md  config.json
  research/            (project research; .cache for web/synthesis results, ARCHITECTURE.md:402)
  phases/
    <NN>-<slug>/
      <NN>-CONTEXT.md          discuss output (LOCAL:workflows/discuss-phase.md:430)
      <NN>-RESEARCH.md         researcher output (UP:docs/explanation/the-phase-loop.md:37)
      <NN>-<PP>-PLAN.md        e.g. 01-01-PLAN.md, 02.1-01-PLAN.md (LOCAL:agents/gsd-planner.md:831-834)
      <NN>-<PP>-SUMMARY.md     executor output; matched as .planning/phases/*/*-SUMMARY.md (LOCAL:commands/gsd/audit-milestone.md:35). The NN-PP form is ASSUMPTION by symmetry with PLAN.
      <NN>-VERIFICATION.md     verifier output (the-phase-loop.md:53; glob in audit-milestone.md:36)
```

- `STATE.md` is the navigation layer: active milestone, phase in progress, plans done and pending; every workflow reads it first (the-phase-loop.md:102). The roadmapper creates it from `templates/state.md` and writes `ROADMAP.md` + `STATE.md` immediately for durability (LOCAL:agents/gsd-roadmapper.md:44-45, 453, 470-471).
- `ROADMAP.md` needs two phase representations (summary checklist and detail sections); `phase_id_convention` in `config.json` sets header form (LOCAL:agents/gsd-roadmapper.md:216-220, 330-332).
- Write guard: a `gsd-write-guard` PreToolUse hook blocks shrinking curated `.planning/` files; callers arm it by writing the path into `.planning/.gsd-allow-shrink` (LOCAL:agents/gsd-roadmapper.md:581-600). Hosts without hook support get no such guard.
- `config.json` keys relevant here: `model_profile` (default `balanced`), `model_overrides`, `agent_tools`, `models`, `dynamic_routing`, `runtime`, `commit_docs`, `parallelization`, `phase_naming` (UP:docs/CONFIGURATION.md:18-23, 226-232; LOCAL:bin/shared/config-defaults.manifest.json:3-12). Workstreams honor `GSD_WORKSTREAM` (ARCHITECTURE.md:337).
- Ultrathink's own sub-issue PRDs (workstream 2) are not part of this layout. Anything we add under `.planning/` must avoid the curated-file names above and the write guard. [INFERENCE]

## 8. Model routing

- Profiles: `quality, balanced, budget, adaptive, inherit`; phase types `planning, discuss, research, execution, verification, completion`; adaptive tier map `heavy to opus, standard to sonnet, light to haiku` (LOCAL:bin/shared/model-catalog.json:1-8).
- Concrete tier-to-model defaults exist only for claude, codex, qwen, opencode, copilot, hermes, kilo, pi (LOCAL:model-catalog.json:9-99). They are `null` for cline, kimi, kimi-code, cursor, windsurf, zcode, augment, trae, codebuddy, antigravity, so those runtimes use their own default model.
- Resolution precedence: `model_overrides[agent]`, then `model_policy.runtime_tiers`, `model_policy` flat keys, `model_profile_overrides`, built-in catalog, tier alias (UP:docs/CONFIGURATION.md:2361-2368).
- Opencode embeds the resolved model into each agent's frontmatter at install, so changing overrides needs a reinstall (UP:docs/CONFIGURATION.md:228).
- `reasoning_effort` is forwarded only to Codex (UP:docs/CONFIGURATION.md:2357). `effortSurface` is `argv` only for claude, opencode, codex, pi (MATRIX).
- A global `~/.gsd` config is NOT read for model resolution inside a project that has `.planning/config.json` (UP:docs/CONFIGURATION.md:2445-2450).

## 9. Capability matrix source

MATRIX records per-runtime axes with cited evidence: `commandSurface`, `modelMode` (active or passive), `hookBus` (host, engine, none), `dispatch.namedDispatch/nested/maxDepth/background`, `effortSurface`. Values without a primary source are the sentinel `undocumented` and degrade closed (MATRIX, intro and Axes legend). Summary used in `agent-matrix.md`:

| Runtime | modelMode | hookBus | namedDispatch | nested (maxDepth) | background |
|---|---|---|---|---|---|
| claude | passive | host | true | true (5) | true |
| codex | passive | host | true | true (1) | true |
| opencode | active | host | not read | not read | not read |
| cursor | passive | host | true | true (2) | true |
| cline | active | host | true | false (1) | true |
| hermes | active | host | false | true (1) | true |
| antigravity | passive | host | undocumented | undocumented | true |
| augment | passive | host | true | undocumented | true |
| qwen | passive | host | true | false (1) | true |
| codebuddy | passive | host | true | false (1) | true |
| copilot | passive | host | not read | not read | not read |
| kilo | not read | not read | not read | not read | not read |
| windsurf | passive | host | undocumented | undocumented | undocumented |
| trae | passive | engine | true | undocumented | true |
| kimi | passive | host | true | false (1) | true |
| kimi-code | passive | host | false | true | not read |
| zcode | not read | not read | not read | not read | not read |
| pi | active (install doc) | none | undocumented | undocumented (0) | false |

MATRIX line refs: claude 70-86, codex 107-124, opencode 155-164, cursor 205-220, cline 243-258, hermes 282-297, antigravity 321-336, augment 360-375, qwen 425-440, codebuddy 463-478, copilot 497-506, kilo 534, windsurf 573-588, trae 616-631, kimi 657-674, kimi-code 696-713, zcode 743, pi 786-803.

## 10. Gaps and caveats

- UP docs disagree in places (Kilo and Augment hooks, Claude local command form). INSTALL.js is the tiebreaker and was only partially read; those cells are marked UNVERIFIED.
- I did not run the installer. Everything is read from docs and source text.
- The `kimi` local marker (`LOCAL:.gsd-runtime`) means the local copy was laid down by a Kimi install. I did not see a transformed Kimi skill tree in `/root/.agents/gsd-core`; the `/root/.agents/skills` root named in the docs was not inspected. UNVERIFIED.
- ARCHITECTURE.md was last aligned with a different GSD version than 1.21.0; ZCode, Pi and Kimi Code are missing from its matrix.
