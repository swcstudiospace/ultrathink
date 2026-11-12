# Host plugin contracts: Omp, Hermes, Prime Agent, Claude Code, Grok Build, Muse Code

Date checked for every fact: 2026-11-12. Each fact line is `fact | source ID | host version | date checked`.
Source IDs resolve to the exact path or URL in the key below. "not documented" means no primary source confirmed the item.

## Classification summary

| Host | Mechanism | Classification |
|---|---|---|
| Omp | Extension factory via `package.json` `omp.extensions` | usable |
| Hermes | Native `plugin.yaml` plus `register(ctx)` | usable |
| Prime Agent | Capability packages providing `SKILL.md` skills (no hook or command API) | usable (skill entry point only) |
| Claude Code | `.claude-plugin/plugin.json` plus default-layout components | usable |
| Grok Build | Plugin folders with `skills/`, `commands/`, `agents/`, `hooks/hooks.json`, `.mcp.json` | usable |
| Muse Code | Official skills and settings hooks; native `.muse-plugin/plugin.json` bundles | usable |

No host is blocked: each has at least one documented mechanism that registers a slash command or a skill-based workflow entry point.

## Source key

Local (read on 2026-11-12):

- S-OMP-SRC: /root/src/repos/claude-ultrathink/src/host/omp.ts
- S-OMP-PKG: /root/src/repos/claude-ultrathink/package.json (`omp` and `pi` keys)
- S-OMP-PATHS: /root/src/repos/claude-ultrathink/src/host/paths.ts
- S-OMP-CLI: local `omp --help`, `omp plugin --help`, `omp plugin uninstall --help`, `omp plugin install --dry-run .`
- S-HER-DEV: /root/.hermes/hermes-agent/website/docs/developer-guide/plugins/index.md
- S-HER-UG: /root/.hermes/hermes-agent/website/docs/user-guide/features/plugins.md
- S-HER-HK: /root/.hermes/hermes-agent/website/docs/user-guide/features/hooks.md
- S-HER-CAT: /root/.hermes/hermes-agent/website/docs/developer-guide/plugins/catalog-submission.md
- S-HER-CLI: local `hermes plugins --help`, `hermes plugins install --help`, `hermes plugins remove --help`, `hermes plugins validate hosts/hermes`
- S-HER-REPO: /root/src/repos/claude-ultrathink/hosts/hermes/plugin.yaml and __init__.py
- S-PA-SC: /root/.local/share/prime-agent/releases/0.10.2-linux-x64-09659961dfde201cc39f1e69b607385d708da3e591f267a4fea04970afb8b005/skills/skill-creator/SKILL.md and references/python-skills.md
- S-PA-CLI: local `prime-agent --help`, `prime-agent package --help`, `prime-agent package install --help`, `prime-agent update --help`, `prime-agent package list`
- S-PA-RT: /root/.local/share/prime-agent/releases/0.10.2-linux-x64-09659961dfde201cc39f1e69b607385d708da3e591f267a4fea04970afb8b005/prime-agent-runtime/src/rlm/ (grep for hook, extension, register)
- S-PA-BIN: strings of .../releases/0.10.2-.../prime-agent (binary)
- S-PA-HOST: /root/src/repos/claude-ultrathink/hosts/prime-agent/SKILL.md and commands/*/SKILL.md
- S-CC-REPO: /root/src/repos/claude-ultrathink/.claude-plugin/plugin.json and marketplace.json
- S-CC-LOCAL: local `claude --help`, `claude plugin --help`, `claude plugin marketplace --help`, `claude plugin uninstall --help`, `claude plugin validate .`
- S-GK-LOCAL: local `grok --help`, `grok plugin --help`, `grok plugin install --help`, `grok plugin validate .`, `grok plugin list`; strings of /usr/lib/node_modules/@xai-official/grok/bin/grok-native
- S-MU-LOCAL: local `muse --help`, `muse plugins --help`, `muse plugins install --help`, `muse plugins validate .`, `muse plugins list`
- S-MU-REPO: /root/src/repos/claude-ultrathink/.muse-plugin/plugin.json
- S-MU-REL: /root/.local/bin/.muse-release-info.json
- S-MU-SNIP: /root/.local/share/realm-build/docs/hosts/snippets/muse-code.md (secondary, written by another project; used only as a lead, never as the sole source)

Web (fetched 2026-11-12):

- S-OMP-EXT: https://omp.sh/docs/extension-authoring
- S-OMP-PLG: https://omp.sh/docs/plugins
- S-OMP-MKT: https://omp.sh/docs/marketplace
- S-PA-REPO: https://github.com/PrimeIntellect-ai/prime-agent (current repo is Rust; https://github.com/PrimeIntellect-ai/prime-agent/blob/main/docs/packages.md and .../docs/skills.md return HTTP 404)
- S-CC-PLUG: https://code.claude.com/docs/en/plugins/overview.md
- S-CC-REF: https://code.claude.com/docs/en/plugins-reference (markdown alternate of the manifest reference)
- S-CC-INST: https://code.claude.com/docs/en/plugins/install.md
- S-CC-COMP: https://code.claude.com/docs/en/plugins/components.md
- S-CC-CREATE: https://code.claude.com/docs/en/plugins/create.md
- S-CC-CLI: https://code.claude.com/docs/en/plugins/cli-reference.md
- S-CC-MODS: https://code.claude.com/docs/en/plugins/mods/overview.md
- S-GK-DOC: https://docs.x.ai/build/features/skills-plugins-marketplaces
- S-GK-HK: https://docs.x.ai/build/features/hooks
- S-GK-MKT: https://github.com/xai-org/plugin-marketplace (README via GitHub API)
- S-MU-EXT: https://dev.meta.ai/docs/muse-code/extending
- S-MU-CFG: https://dev.meta.ai/docs/muse-code/configuration

Host versions used: Omp 18.19.0; Hermes Agent v0.23.1 (2026.9.24); Prime Agent 0.10.2 (Rust release); Claude Code 2.1.322; Grok Build 1.0.77; Muse Code 1.4.14 (channel latest 1.4.15 per S-MU-REL); repo plugin 1.4.0.

---

## 1. Omp (reference)

Repo entry and manifest, read from source (not from memory):

- Entry: `src/host/omp.ts` declares `export default createOmpExtension();` and `createOmpExtension(...)` returns `(pi: ExtensionAPI) => void` | S-OMP-SRC | 18.19.0 | 2026-11-12
- `package.json` declares `"omp": { "extensions": ["./src/host/omp.ts"] }` and a legacy `"pi"` key with the same value | S-OMP-PKG | 18.19.0 | 2026-11-12
- Omp docs: the `omp.extensions` array is relative to package root; `.ts`, `.js`, `.mjs`, `.cjs` allowed; the legacy `pi.extensions` remains compatible | S-OMP-EXT | 18.19.0 | 2026-11-12
- Mechanism: extension factory receives `ExtensionAPI` (`on`, `registerCommand`, `registerTool`, `registerShortcut`, `registerFlag`, `registerMessageRenderer`, `sendMessage`, `sendUserMessage`, `appendEntry`, `exec`, `events`) | S-OMP-EXT, S-OMP-SRC (`ExtensionAPI` interface, lines 279-322) | 18.19.0 | 2026-11-12
- Commands: `pi.registerCommand("ultrathink-<verb>")` for verbs `quick`, `skip`, `off`, `on`, `track`, `status` (verb table at S-OMP-SRC lines 1194-1202; registration loop at 2279-2332) | S-OMP-SRC | 18.19.0 | 2026-11-12
- Commands: also `ultrathink-ui` (S-OMP-SRC line 2338) and `ultrathink-swarm` (line 2361) | S-OMP-SRC | 18.19.0 | 2026-11-12
- Hooks used by `omp.ts`: `pi.on` for `session_start` (2086), `session_switch` (2094), `session_shutdown` (2106), a lifecycle loop (2124), `turn_start` (2129), `tool_result` (2140, 2157), `agent_end` (2239), `before_agent_start` (2766) | S-OMP-SRC | 18.19.0 | 2026-11-12
- Hook event names the API accepts: `before_agent_start`, `input`, `tool_result`, and `session_start`, `session_switch`, `session_shutdown`, `agent_start`, `agent_end`, `turn_start`, `turn_end`, `tool_execution_start`, `tool_execution_end` | S-OMP-SRC (`LifecycleEvent` at lines 252-261) | 18.19.0 | 2026-11-12
- Skills: `omp.ts` registers no skills. Package convention allows `skills/` directories, and the docs say packages may ship `skills/`, `commands/`, `hooks/`, `tools/`, `rules/`, `prompts/`, `agents/` plus `.mcp.json` or `mcp.json` | S-OMP-PLG, S-OMP-SRC (grep: no skill registration) | 18.19.0 | 2026-11-12
- Subagents: `agents/` directory convention documented; `omp.ts` defines no subagent definitions | S-OMP-PLG, S-OMP-SRC | 18.19.0 | 2026-11-12
- Persistent state: host state directory resolves to `PI_CODING_AGENT_DIR` if set, else `~/.omp/agent`; per-cwd ultrathink state dir is built by `stateDir(cwd)` at S-OMP-SRC line 1429 | S-OMP-PATHS (lines 38-39), S-OMP-SRC | 18.19.0 | 2026-11-12
- Interactive prompts: `ctx.ui.notify`, `ctx.ui.setWidget("ultrathink")` (line 1550), and a structural `ctx.ui.custom` dashboard (ExtensionUI, lines 170-190) | S-OMP-SRC | 18.19.0 | 2026-11-12
- Install: `omp plugin install <npm package | github:org/repo#ref | git URL | ./local path | plugin@marketplace>`; `omp plugin link <path>` for development; marketplace installs take `--scope user|project` | S-OMP-PLG, S-OMP-CLI | 18.19.0 | 2026-11-12
- Install dry run on this repo: `omp plugin install --dry-run .` prints `[dry-run] Would link .` and does not install | S-OMP-CLI (local run) | 18.19.0 | 2026-11-12
- Uninstall: `omp plugin uninstall` (action listed in `omp plugin --help`) | S-OMP-CLI | 18.19.0 | 2026-11-12
- Reload: run `/reload-plugins` or restart omp; source edits show through the symlink only after reload or restart | S-OMP-PLG (section "Inspect, disable, and enable" and "Install a local plugin"), S-OMP-MKT ("Restart the session for tools, hooks, or extension modules") | 18.19.0 | 2026-11-12
- Minimum supported omp version: not documented. Repo dev dependency pins `@oh-my-pi/pi-ai ^18.14.0` (S-OMP-PKG devDependencies, observed only) | S-OMP-EXT, S-OMP-PKG | 18.19.0 | 2026-11-12
- Classification: usable. Mechanism: `package.json` `omp.extensions` entry plus `pi.registerCommand` (S-OMP-PKG, S-OMP-SRC lines 279-313, 2279-2332) | 18.19.0 | 2026-11-12

## 2. Hermes Agent

- Mechanism: native directory plugins with `plugin.yaml` plus `register(ctx)`; this is the documented general plugin surface | S-HER-UG (lines 19-31), S-HER-DEV (lines 315-368) | v0.23.1 (2026.9.24) | 2026-11-12
- Discovery locations: bundled `<repo>/plugins/`; user `~/.hermes/plugins/`; project `.hermes/plugins/` is not loaded by the gateway; pip entry points in group `hermes_agent.plugins` | S-HER-UG (lines 145-155, 97-101) | v0.23.1 | 2026-11-12
- Manifest format `plugin.yaml` keys documented: `name`, `version`, `description`, `author`, `provides_tools`, `provides_hooks`, `requires_env`, `capabilities`, `python_dependencies`, `python_runtime`, `config_schema`, `config_keys`, `requires_plugins`, `requires_auth`, `oauth`, `manifest_version` (max 2), `api_version`, `license`, `homepage`, `tags`, `provides_locales` | S-HER-DEV (lines 355-389, 607-629) | v0.23.1 | 2026-11-12
- Unknown `plugin.yaml` fields are ignored with a warning, not an error | S-HER-DEV (line 254, "Manifests are open to additions") | v0.23.1 | 2026-11-12
- Repo finding: `hosts/hermes/plugin.yaml` declares its hooks under `hooks:`, which is not a documented key; the documented key is `provides_hooks:`. `hermes plugins validate hosts/hermes` reports `declared hooks — undeclared hooks registered (not in provides_hooks)` for seven hooks and ends `Validation failed.` | S-HER-REPO, S-HER-CLI (local run), S-HER-DEV (line 364) | v0.23.1 | 2026-11-12
- Repo finding: `hermes plugins validate hosts/hermes` also reports `requires_hermes — not declared` and `private core imports` for `bridge.py:153` (`hermes_cli.plugins`) | S-HER-CLI (local run) | v0.23.1 | 2026-11-12
- Commands: `ctx.register_command(name, handler, description="", args_hint="")` adds `/name` in CLI and gateway sessions; a name that collides with a built-in command is silently rejected with a log warning | S-HER-DEV (signature line 1808; collision rule ~1787-1840), S-HER-UG (line 111) | v0.23.1 | 2026-11-12
- Command handlers run in the gateway process; they must return text, not print | S-HER-UG (lines 133-140) | v0.23.1 | 2026-11-12
- CLI subcommands: `ctx.register_cli_command(name, help, setup_fn, handler_fn)` adds `hermes <plugin> <subcommand>` | S-HER-UG (line 113) | v0.23.1 | 2026-11-12
- Skills: `ctx.register_skill(name, path)` ships read-only skills namespaced `plugin:skill`, loaded through `skill_view("plugin:skill")` | S-HER-DEV (lines ~1181-1215), S-HER-UG (line 117) | v0.23.1 | 2026-11-12
- Hooks: `ctx.register_hook(event, callback)`; documented events include `pre_tool_call`, `post_tool_call`, `pre_llm_call`, `post_llm_call`, `pre_api_request`, `post_api_request`, `on_session_start`, `on_session_end`, `on_session_finalize`, `on_session_reset`, `on_session_delete` | S-HER-DEV (hook reference table ~1532-1545), S-HER-HK | v0.23.1 | 2026-11-12
- Hooks also documented: `transform_tool_result` (S-HER-HK line 457), `pre_verify` (line 463), `subagent_start` (line 484) | S-HER-HK | v0.23.1 | 2026-11-12
- Tools: `ctx.register_tool(name, toolset, schema, handler)` | S-HER-UG (lines 79-84, the minimal example), S-HER-DEV (Step 5 registration), S-HER-REPO | v0.23.1 | 2026-11-12
- Subagent definitions: none documented as plugin-registrable. `subagent_start` is an observer hook only. `ctx.register_delegation_provider` routes `delegate_task` but does not define agents | S-HER-UG (line 122), S-HER-HK (line 484) | v0.23.1 | 2026-11-12
- Persistent state: `plugin_data_dir()` and `plugin_db()` survive `hermes plugins update` and `remove`; `ctx.get_config()`/`ctx.set_config()`; `ctx.state` | S-HER-DEV (lines 52, ~963-995, 1744) | v0.23.1 | 2026-11-12
- Interactive prompts: install-time prompts for `requires_env`; `Enable 'name' now? [y/N]` after `hermes plugins install owner/repo`; capability consent; `python_dependencies` consent; `ctx.register_approval_transport(name, present_fn)` routes human approval prompts | S-HER-UG (lines 118, 127, 222), S-HER-DEV (lines 380-389, 620, 650-654) | v0.23.1 | 2026-11-12
- Install: `hermes plugins install <catalog entry | git URL | owner/repo> [--ref 40-char-sha] [--enable|--no-enable] [--yes-deps] [--force]` | S-HER-CLI (local help), S-HER-UG (lines 222-249) | v0.23.1 | 2026-11-12
- Uninstall: `hermes plugins remove <name>` (aliases rm, uninstall) | S-HER-CLI (local help) | v0.23.1 | 2026-11-12
- Enable/disable: `hermes plugins enable|disable <name>`. General plugins are opt-in via `plugins.enabled` in `~/.hermes/config.yaml`; bundled backends load automatically | S-HER-UG (lines 173-215, 280-290) | v0.23.1 | 2026-11-12
- Reload: install and enable nudge the running gateway (`reload-plugins` control verb); gateway slash commands and hooks wire immediately; `tools` and `prompt` sections apply from the next session; `restart_required` is true only when no gateway answered | S-HER-DEV (~lines 2215-2241) | v0.23.1 | 2026-11-12
- Validation: `hermes plugins validate <dir>` is the catalog CI gate; `hermes plugins doctor` runs discovery and registration in a temporary `HERMES_HOME` | S-HER-DEV (lines 50-51, 332-351), S-HER-CLI | v0.23.1 | 2026-11-12
- Minimum supported Hermes version: not documented. `requires_hermes` exists only at catalog level and is absent from this repo's `plugin.yaml` | S-HER-CAT (lines 178-186), S-HER-CLI | v0.23.1 | 2026-11-12
- Classification: usable. Mechanism: `plugin.yaml` plus `register(ctx)` with `ctx.register_command` (S-HER-DEV, S-HER-UG) | v0.23.1 | 2026-11-12

## 3. Prime Agent

- Mechanism: capability packages installed with `prime-agent package install`; packages "can provide skills, prompts, and themes" | S-PA-CLI (`package --help`) | 0.10.2 | 2026-11-12
- Commands: `prime-agent package install <source> [--local]`, `remove`, `list`, `update`. `--local` installs into the project | S-PA-CLI | 0.10.2 | 2026-11-12
- Skill manifest: `SKILL.md` with YAML frontmatter; `name` (max 64 chars, matches directory) and `description` (max 1024) are required; a skill with an empty description is silently not loaded | S-PA-SC (Frontmatter table) | 0.10.2 | 2026-11-12
- Skill frontmatter also documented: `disable-model-invocation` (true hides from the startup prompt; only `/skill:<name>` invokes), `license`, `compatibility`, `metadata` | S-PA-SC | 0.10.2 | 2026-11-12
- Skill locations: project `.prime/agent/skills/<name>/`; personal `~/.prime/agent/skills/<name>/`; package `skills/` directory or `pi.skills` in `package.json`; built-in release `skills/`. Precedence: `--skill` paths and `skills` settings, then project, global, package, built-in | S-PA-SC (Pick the location; precedence paragraph) | 0.10.2 | 2026-11-12
- Discovery paths also include `~/.agents/skills/` and `.agents/skills/` in the Prime Agent binary behavior described by the bundled skill-creator | S-PA-SC (first paragraphs); UNVERIFIED for 0.10.2 beyond that text | 0.10.2 | 2026-11-12
- Command flags: `--skill <path>` (repeatable), `--no-skills`, `--prompt-template <path>`, `--theme <path>` | S-PA-CLI (`--help` Resource options) | 0.10.2 | 2026-11-12
- Python-backed skills: `pyproject.toml` at skill root plus `src/<import_name>/__init__.py`; the package installs editable into the kernel venv at `~/.prime/agent/kernel-venv` | S-PA-SC (Detection Contract; Python-backed section) | 0.10.2 | 2026-11-12
- Slash commands: invoked as `/skill:<name>`. No third-party slash-command registration API found: the binary's `slash_commands` symbols are built-in registries (`pa_types::slash_commands`), and the runtime `rlm` package has no `register_command` | S-PA-SC, S-PA-BIN, S-PA-RT (grep) | 0.10.2 | 2026-11-12
- The repo's own ultrathink for Prime Agent says Prime Agent "has no prompt hook" and "no command hook", so each `/ultrathink-*` command ships as a `SKILL.md` skill | S-PA-HOST (`SKILL.md` and `commands/ultrathink-on/SKILL.md`) | 0.10.2 | 2026-11-12
- Hooks: none documented. The runtime `rlm` package has no hook or extension registration API (grep for hook, extension, register_tool, register_command, on_event returned only unrelated matches) | S-PA-RT | 0.10.2 | 2026-11-12
- Subagents: spawned from the kernel with `await rlm.spawn(...)` (skill code may call it). No plugin-declared subagent definitions documented | S-PA-SC (python-skills section) | 0.10.2 | 2026-11-12
- Persistent state: Prime Agent state root is `${PRIME_AGENT_CODING_AGENT_DIR:-~/.prime/agent}`; the ultrathink host uses `<root>/ultrathink/` | S-PA-HOST (SKILL.md line 8), S-PA-BIN (string `PRIME_AGENT_CODING_AGENT_DIR`) | 0.10.2 | 2026-11-12
- Package-level data directory: not documented | S-PA-CLI, S-PA-SC | 0.10.2 | 2026-11-12
- Interactive prompts for packages: none documented | S-PA-CLI, S-PA-SC | 0.10.2 | 2026-11-12
- Install: `prime-agent package install <source> [--local]`; the source-kind syntax (npm, git, path) is not stated in local help, and the public TypeScript-era README (not the current Rust tree) documents `npm:` sources. UNVERIFIED for 0.10.2 | S-PA-CLI, S-PA-REPO (web excerpt, not fetched from primary) | 0.10.2 | 2026-11-12
- Uninstall: `prime-agent package remove` | S-PA-CLI | 0.10.2 | 2026-11-12
- Reload: skills load at startup; the bundled skill-creator says to start a fresh session to confirm a skill loads; `prime-agent update` requires a restart | S-PA-SC (Verifying step 3), S-PA-CLI (`update --help`) | 0.10.2 | 2026-11-12
- Minimum supported version: not documented. Current public repo is Rust (`prime-agent update` replaces the TypeScript build) | S-PA-REPO, S-PA-CLI | 0.10.2 | 2026-11-12
- Classification: usable, limited to skills as the workflow entry point (`/skill:<name>`). No hook or command-registration API exists | S-PA-SC, S-PA-HOST | 0.10.2 | 2026-11-12

## 4. Claude Code

- Mechanism: Claude Code plugins, a directory of skills, agents, hooks, MCP servers, and a manifest; installed from marketplaces or loaded with `--plugin-dir` | S-CC-PLUG, S-CC-CREATE | 2.1.322 | 2026-11-12
- Manifest location and format: `.claude-plugin/plugin.json` (JSON), optional; only `name` is required inside it | S-CC-COMP (manifest section), S-CC-REF (manifest file section) | 2.1.322 | 2026-11-12
- Default layout: `skills/` (one `<name>/SKILL.md` each), `commands/`, `agents/`, `hooks/hooks.json`, `.mcp.json` at the plugin root (not inside `.claude-plugin/`) | S-CC-REF (default-location table), S-CC-CREATE | 2.1.322 | 2026-11-12
- Manifest keys that replace or add to defaults: `commands`, `agents`, `outputStyles`, `workflows` replace; `skills` adds to the default | S-CC-REF ("How each key combines with its default location") | 2.1.322 | 2026-11-12
- Commands: a file `commands/<file>.md` runs as `/<plugin>:<file>`; manifest `commands` maps names to `source` or inline `content` with `description`, `argumentHint`, `model`, `allowedTools` | S-CC-COMP (Commands), S-CC-REF (`commands`) | 2.1.322 | 2026-11-12
- Skills: `SKILL.md` runs by name as a command and loads on demand; namespaced `/<plugin>:<skill>` | S-CC-PLUG (Skills), S-CC-CREATE (naming) | 2.1.322 | 2026-11-12
- Subagents: `agents/*.md` default location; plugin agents get the plugin-name prefix | S-CC-REF (default-location table), S-CC-CREATE | 2.1.322 | 2026-11-12
- Hooks: `hooks/hooks.json` must wrap events in a top-level `"hooks"` key; the manifest `hooks` key takes a path, an inline object, or an array; every hook process gets `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PLUGIN_DATA`, and `CLAUDE_PLUGIN_OPTION_<KEY>` | S-CC-REF (`hooks` section, ~lines 340-383) | 2.1.322 | 2026-11-12
- Mods: JavaScript hook modules listed under a `modules` key in `hooks/hooks.json`; a plugin with one is a "mod" that can add commands and panes | S-CC-COMP (line ~370), S-CC-MODS | 2.1.322 | 2026-11-12
- MCP servers: `.mcp.json` at plugin root, same shape as a project `.mcp.json`; manifest key `mcpServers` | S-CC-REF, S-CC-COMP | 2.1.322 | 2026-11-12
- Interactive prompts: `userConfig` options declared in the manifest are prompted at install in `/plugin`; `sensitive: true` values go to secure storage; `/plugin configure <name>` reopens the dialog | S-CC-REF (`userConfig`, field table ~441-448), S-CC-CREATE (troubleshooting), S-CC-CLI (`--config`) | 2.1.322 | 2026-11-12
- Persistent state: plugin data directory `~/.claude/plugins/data/<id>/` (via `CLAUDE_PLUGIN_DATA`); deleted on last-scope uninstall, with exceptions listed in the CLI reference | S-CC-CLI ("What an uninstall deletes and keeps") | 2.1.322 | 2026-11-12
- Install in session: `/plugin install <plugin>@<marketplace>` opens the details panel; the `--marketplace` form needs Claude Code v2.1.275 or later | S-CC-INST (Install a plugin, tab Terminal) | 2.1.322 | 2026-11-12
- Install from shell: `claude plugin install <plugin>@<marketplace> [--scope user|project|local]`; default scope `user`; shell install needs v2.1.292 or later | S-CC-CLI, S-CC-INST | 2.1.322 | 2026-11-12
- Local, single-session load without install: `claude --plugin-dir <plugin folder>` | S-CC-LOCAL (`claude --help`), S-CC-CREATE | 2.1.322 | 2026-11-12
- Uninstall: `claude plugin uninstall|remove <plugin>`; in session `/plugin uninstall` | S-CC-LOCAL (`uninstall --help`), S-CC-INST | 2.1.322 | 2026-11-12
- Enable/disable: `claude plugin enable|disable`; `defaultEnabled` manifest field sets start-off plugins | S-CC-INST, S-CC-CLI | 2.1.322 | 2026-11-12
- Reload: `/reload-plugins` in a running session, or start a new session; closing `/plugin` with pending changes runs `/reload-plugins` | S-CC-COMP (intro), S-CC-INST (Manage installed plugins) | 2.1.322 | 2026-11-12
- Update: `claude plugin update <plugin>` ; CLI help says "restart required to apply", while the install doc says "Run /reload-plugins to apply". The two sources conflict; both recorded | S-CC-LOCAL (`claude plugin --help`), S-CC-CLI (update section), S-CC-INST (Keep plugins updated) | 2.1.322 | 2026-11-12
- Validation: `claude plugin validate <path>` checks manifest and components; repo plugin passes with an icon warning | S-CC-LOCAL (local run on repo root), S-CC-REF (Validate the manifest) | 2.1.322 | 2026-11-12
- Minimum supported version: no base version documented for the plugin system. Feature-level minimums appear: v2.1.268 (`errorDetails`, `--json`), v2.1.275 (in-session marketplace install), v2.1.281 (MCP validation), v2.1.283 (`outputStyles`/`lspServers`/`monitors`/`themes` validation), v2.1.292 (shell install) | S-CC-REF, S-CC-CLI, S-CC-INST | 2.1.322 | 2026-11-12
- Classification: usable. Mechanism: `.claude-plugin/plugin.json` with default-layout `commands/` and `skills/` components (S-CC-REF, S-CC-COMP) | 2.1.322 | 2026-11-12

Evidence from this repo (cited as evidence only; the contract is the official docs above):

- `.claude-plugin/plugin.json` declares name `ultrathink`, version `1.4.0`, description, author, homepage, repository, license, keywords. It declares no component keys, so `commands/`, `skills/`, and `hooks/hooks.json` load from the default layout | S-CC-REPO | 1.4.0 | 2026-11-12
- `.claude-plugin/marketplace.json` lists one plugin `ultrathink` with `"source": "./"`, version `1.4.0`, category `productivity` | S-CC-REPO | 1.4.0 | 2026-11-12
- `claude plugin validate .` on the repo root: "Validation passed" (exit 0) with one warning `ICON_MISSING` | S-CC-LOCAL | 2.1.322 | 2026-11-12
- `grok plugin validate .` on the repo root reads `.claude-plugin/plugin.json` and reports 1 skill dir, 1 command dir, 0 agent dirs, and hooks | S-GK-LOCAL | 1.0.77 | 2026-11-12

## 5. Grok Build

- Mechanism: plugins extend Grok with skills, agents, hooks, MCP servers, and LSP servers | S-GK-DOC (Plugins section) | 1.0.77 | 2026-11-12
- Manifest location: optional `plugin.json` at the plugin root, with metadata and path overrides; `.grok-plugin/plugin.json` and the `.claude-plugin/` equivalents are accepted. Without a manifest, Grok discovers components from standard directories | S-GK-LOCAL (strings: "No plugin.json found. Grok discovers skills, agents, and hooks automatically"; "accepts .grok-plugin/plugin.json and the .claude-plugin/ equivalents") | 1.0.77 | 2026-11-12
- Manifest fields beyond the common metadata are not in the official Grok docs; the xAI marketplace README lists metadata fields and says nothing on path-override keys | S-GK-MKT, S-GK-DOC | 1.0.77 | 2026-11-12
- Folder layout: `skills/<name>/SKILL.md`, `commands/`, `agents/`, `hooks/hooks.json`, `.mcp.json`, and an optional `plugin.json` | S-GK-LOCAL (strings: "A plugin folder holds any of skills/, commands/, agents/, hooks/hooks.json, .mcp.json"), S-GK-MKT (component index) | 1.0.77 | 2026-11-12
- Plugin discovery paths: `./.grok/plugins/`, `~/.grok/plugins/`, `~/.grok/plugins/marketplaces/`, `[plugins] paths` in `~/.grok/config.toml`, `--plugin-dir <PATH>` | S-GK-DOC | 1.0.77 | 2026-11-12
- Marketplace catalog: `.grok-plugin/marketplace.json`; plugin sources are `url` (40-character commit `sha` required) or `local` (`source.path`); `.grok-plugin/plugin-index.json` is generated | S-GK-MKT | 1.0.77 | 2026-11-12
- Skills: `SKILL.md` frontmatter fields `name`, `description`, `when-to-use`, `paths`, `allowed-tools`, `argument-hint`, `user-invocable` (default true), `disable-model-invocation`, `metadata` | S-GK-DOC (Skills table) | 1.0.77 | 2026-11-12
- Commands: user-invocable skills appear as slash commands `/<skill-name>`; plugin `commands/` directory is detected by the validator | S-GK-DOC (Skills), S-GK-LOCAL (validate output) | 1.0.77 | 2026-11-12
- Subagents: plugin `agents/` directory holds subagent definitions | S-GK-MKT (component index), S-GK-LOCAL (validate output: 0 agent dirs in repo) | 1.0.77 | 2026-11-12
- Hooks: plugin hooks live in `hooks/hooks.json`; events are `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `PreToolUse` (the only blocking event), `PostToolUse`, `PostToolUseFailure`, `PermissionDenied`, `Stop`, `StopFailure`, `Notification`, `SubagentStart`, `SubagentStop`, `PreCompact`, `PostCompact`; a `PreToolUse` hook denies by JSON `{"decision":"deny"}` or exit 2 | S-GK-HK (Events, script contract), S-GK-LOCAL | 1.0.77 | 2026-11-12
- Plugin hooks receive `GROK_PLUGIN_ROOT` and `GROK_PLUGIN_DATA` | S-GK-DOC (Plugins/Hooks section), S-GK-LOCAL | 1.0.77 | 2026-11-12
- MCP servers: `.mcp.json` at plugin root | S-GK-LOCAL, S-GK-MKT | 1.0.77 | 2026-11-12
- Persistent state: `GROK_PLUGIN_DATA` is the plugin's writable data directory | S-GK-LOCAL (strings), S-GK-DOC | 1.0.77 | 2026-11-12
- Interactive prompts: `grok plugin install` asks for trust unless `--trust` is passed; plugin skills, hooks, and MCP servers stay inactive until the plugin is trusted | S-GK-LOCAL (`install --help`; strings: "don't load until the plugin is trusted") | 1.0.77 | 2026-11-12
- Install: `grok plugin install <git URL | user/repo[@ref][#subdir] | local path> [--trust]`; `grok plugin marketplace add <source>` | S-GK-LOCAL | 1.0.77 | 2026-11-12
- Uninstall: `grok plugin uninstall <name>` (aliases `rm`, `remove`) | S-GK-LOCAL | 1.0.77 | 2026-11-12
- Enable/disable: `grok plugin enable|disable <name>` | S-GK-LOCAL | 1.0.77 | 2026-11-12
- Reload: press `r` in the Plugins tab of the extensions modal (`/plugins`), or start a new session | S-GK-LOCAL (strings: "Reload with `r` in the Plugins tab or start a new session") | 1.0.77 | 2026-11-12
- Claude compatibility: Grok reads Claude Code marketplaces, plugins, skills, MCPs, agents, hooks, and CLAUDE.md files without extra setup | S-GK-DOC (Claude Code compatibility) | 1.0.77 | 2026-11-12
- Minimum supported version: not documented | S-GK-DOC, S-GK-MKT | 1.0.77 | 2026-11-12
- Classification: usable. Mechanism: plugin folders with `skills/` and `commands/` (slash commands) plus `hooks/hooks.json` (S-GK-DOC, S-GK-LOCAL) | 1.0.77 | 2026-11-12

Evidence from this repo:

- `grok plugin validate .` returns "Plugin manifest is valid" with name `ultrathink`, version `1.4.0`, components 1 skill dir, 1 command dir, 0 agent dirs, hooks | S-GK-LOCAL | 1.0.77 | 2026-11-12
- `grok plugin list` on this machine shows marketplace-installed plugins from `claude-plugins-official`, which means Grok reads the Claude marketplace catalog | S-GK-LOCAL | 1.0.77 | 2026-11-12

## 6. Muse Code

- Mechanism (official): skills, settings-file hooks, and MCP servers are documented; skills load from built-in, user, project, and plugin sources | S-MU-EXT (Skills, Hooks, MCP sections) | 1.4.14 | 2026-11-12
- Mechanism (native bundles): `.muse-plugin/plugin.json` is a native plugin bundle recognized by the local `muse plugins` command. No public official specification for this bundle format was found; the support is observed in the binary and validator | S-MU-LOCAL, S-MU-REPO; web search for an official spec found none (secondary) | 1.4.14 | 2026-11-12
- Settings file: `~/.config/muse/settings.json` must set `"schema_version": 1`; a missing file is fine | S-MU-CFG (The settings file) | 1.4.14 | 2026-11-12
- Plugin manifest location and format: `.muse-plugin/plugin.json` with `schemaVersion` 1, `name`, `displayName`, `version`, `description`, `compat` (`source`, `manifestDir`), and `capabilities` (`skills`, `commands`, `hooks`, `mcpServers`, `reminders`) each entry `{id, path}` for skills and commands | S-MU-REPO (this repo's manifest) | 1.4.14 | 2026-11-12
- Plugin manifest acceptance: the validator also accepts a root `plugin.json` with the Agent Plugins 1.0.0 `$schema`, or exactly one nested `.muse-plugin/.codex-plugin/.claude-plugin` manifest | S-MU-LOCAL (validator diagnostic `missing-manifest`) | 1.4.14 | 2026-11-12
- Repo finding: when both `.muse-plugin/plugin.json` and `.claude-plugin/plugin.json` exist, Muse selects `.muse-plugin` and ignores `.claude-plugin` | S-MU-LOCAL (validator `multiple-manifests` warning, run on repo root) | 1.4.14 | 2026-11-12
- Skill locations (official): built-in; user `$XDG_CONFIG_HOME/muse/skills` and `~/.agents/skills`; also `~/.claude/skills` and `$CODEX_HOME/skills`; project `<repo>/.agents/skills/<skill-id>/SKILL.md`; plugin-contributed skills | S-MU-EXT (Skills) | 1.4.14 | 2026-11-12
- Skill invocation: a slash shortcut in interactive sessions (for example `/plan`); `muse skills list|inspect|enable|install|validate|import` manage skills | S-MU-EXT (Skills) | 1.4.14 | 2026-11-12
- Plugin commands: native bundle `commands` capability with `{id, path}` entries | S-MU-REPO, S-MU-LOCAL (validator `commands=6`) | 1.4.14 | 2026-11-12
- Hooks (official): project `<project-root>/.muse/hooks.json` (runs after the project folder is trusted); user `hooks` block in settings; managed file at `managed_hooks_path` | S-MU-EXT (Hooks), S-MU-CFG | 1.4.14 | 2026-11-12
- Hook events (official): `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PostToolUseFailure`, `PostToolBatch`, `PreLLMCall`, `PostLLMCall`, `PreCompact`, `PostCompact`, `SubagentStart`, `SubagentStop`, `Notification`, `Stop`, `StopFailure`, `SessionEnd` | S-MU-EXT (Lifecycle events) | 1.4.14 | 2026-11-12
- Hooks in bundles: the native bundle declares a `hooks` capability; the validator counts 3 hooks in this repo | S-MU-LOCAL (`valid ultrathink native skills=5 commands=6 hooks=3`) | 1.4.14 | 2026-11-12
- Hooks run outside the sandbox and approval policy; only read commands you trust | S-MU-EXT (Hooks, warning) | 1.4.14 | 2026-11-12
- Subagents: custom agents are configured through settings or `--agents <JSON>`; the native bundle schema shows no `agents` capability (validator counts only skills, commands, hooks, mcp, reminders) | S-MU-EXT (Subagents), S-MU-LOCAL (`muse --help`, validator line) | 1.4.14 | 2026-11-12
- Persistent state: project memory under `<repo>/.agents/memory/` (committed) and personal project memory outside the repo | S-MU-CFG (Local memory) | 1.4.14 | 2026-11-12
- Plugin data directory: not documented | S-MU-EXT, S-MU-CFG, S-MU-LOCAL | 1.4.14 | 2026-11-12
- Interactive prompts: `muse plugins approve <plugin-id>` trusts and enables the current runtime capability definitions; `reject` disables them | S-MU-LOCAL (`muse plugins --help`) | 1.4.14 | 2026-11-12
- Install: `muse plugins install <path> [--scope user|project] [--json]` or `muse plugins install <plugin>@<marketplace>`; `muse plugins marketplace add <name> <source>` | S-MU-LOCAL | 1.4.14 | 2026-11-12
- Uninstall: `muse plugins remove <id> [--delete-data]` | S-MU-LOCAL | 1.4.14 | 2026-11-12
- Enable/disable/update: `muse plugins enable|disable <id>` ("for future runtime loads"); `muse plugins update <id>` refreshes a local plugin from its source | S-MU-LOCAL | 1.4.14 | 2026-11-12
- Reload: settings-file hooks take effect after a new session starts | S-MU-EXT (Hooks: "start a new session to reload it") | 1.4.14 | 2026-11-12
- Experimental gate: the community reports and the realm snippet say plugin commands need `MUSE_EXPERIMENTAL_PLUGINS=1`. On this machine, `muse plugins validate .` passed both with and without the flag, and `muse plugins list` ran without it. Gate behavior for install and approve was not tested | S-MU-SNIP (secondary), S-MU-LOCAL (local runs) | 1.4.14 | 2026-11-12
- Minimum supported version: not documented. Community reports claim plugins work from 1.3.0; UNVERIFIED | S-MU-EXT, S-MU-LOCAL | 1.4.14 | 2026-11-12
- Local release channel: the installed channel reports 1.4.15 as latest | S-MU-REL | 1.4.14 | 2026-11-12
- Classification: usable. Mechanism: official skills with slash invocation (S-MU-EXT); native bundle validated locally (S-MU-LOCAL) | 1.4.14 | 2026-11-12

Evidence from this repo:

- `muse plugins validate .` (repo root): `valid ultrathink native skills=5 commands=6 hooks=3 mcp=0 reminders=0 diagnostics=2`, with warnings for the `.claude-plugin` precedence and a symlink under `hosts/prime-agent/.venv/bin/python` that escapes the package root | S-MU-LOCAL | 1.4.14 | 2026-11-12
- `muse plugins validate .muse-plugin` alone fails with `missing-manifest`, because the validator expects the manifest at a plugin root, not the manifest folder | S-MU-LOCAL | 1.4.14 | 2026-11-12

---

## Cross-host findings relevant to the Omp-frozen core

- The Hermes manifest uses `hooks:` where the documented key is `provides_hooks:` | S-HER-REPO, S-HER-DEV (line 364) | v0.23.1 | 2026-11-12
- Claude Code and Grok Build both read `.claude-plugin/plugin.json`; Muse Code prefers `.muse-plugin/plugin.json` when both exist | S-CC-REPO, S-GK-LOCAL, S-MU-LOCAL | 2026-11-12
- Omp and Hermes both load code entry points (Omp: a factory exported from `src/host/omp.ts`, declared under `package.json` `omp.extensions`; Hermes: `register(ctx)` in `__init__.py`, declared in `plugin.yaml`). Claude Code, Grok Build, Muse Code, and Prime Agent entries are declarative (manifest, skill files, or `hooks/hooks.json`) | S-OMP-PKG, S-OMP-SRC, S-HER-DEV, S-CC-REF, S-GK-LOCAL, S-MU-REPO, S-PA-SC | mixed versions | 2026-11-12

## Unverified items and gaps

- Minimum supported version: not documented for any host. Recorded as "not documented" above.
- Prime Agent vendor docs at `docs/packages.md` and `docs/skills.md` in the public repo return HTTP 404 (S-PA-REPO). Package source kinds for 0.10.2 are UNVERIFIED.
- Muse Code has no public official plugin-bundle specification. Bundle facts above come from the local binary and validator only.
- Grok Build's official docs do not list plugin-manifest path-override keys. Those are not recorded.
- Claude Code update behavior: the CLI help (restart) and the install doc (`/reload-plugins`) conflict. Both are recorded.
- The realm-build snippets (S-MU-SNIP and the others under /root/.local/share/realm-build/docs/hosts/snippets/) are secondary. They were used only as leads.
