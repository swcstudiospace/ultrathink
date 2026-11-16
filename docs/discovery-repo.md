# Discovery: claude-ultrathink repo map (workstream 0)

Base: `origin/main` worktree of `/root/src/repos/claude-ultrathink`. All paths are repo-relative; `file:line` refs were read from the main checkout at discovery time. Nothing was executed (no tests, lint, installs). Anything not read is marked ASSUMPTION.

## (a) Omp hook/command output path and the "session starts while XML is still generated" trigger

### Files
| Path | What it holds |
|---|---|
| `src/host/omp.ts` (2955 lines) | The whole Omp extension: `createOmpExtension` (:1445), default export (:2955-ish end), `before_agent_start` handler (:2816-2950), flight lifecycle (`start` :2564-2665, `launch` :2668-2700, `settle` :2521-2553), command registration (`pi.registerCommand`, e.g. `ultrathink-swarm` ~:2440), `maybeAutoRun` (AgentSwarm lane auto-run, ~:2718-2815). `ExtensionAPI` shape at :284-310. |
| `src/host/omp-render.ts:18-33` | Message types `PLAN_TYPE="ultrathink-plan"`, `PENDING_TYPE="ultrathink-pending"`, `SYNC_TYPE`, `SHIP_TYPE`; `ACTIVITY_DELIVERY = { deliverAs: "nextTurn", triggerTurn: false }`. |
| `src/host/omp-ui.ts`, `omp-paint.ts`, `omp-insights*.ts`, `omp-insight-actions.ts`, `omp-dashboard.ts`, `omp-graph.ts` | Bar/card UI, insights, dashboard, graph card. Display only. |
| `src/host/plan.ts` | `planPrompt` (:418) - host-neutral planner entry used by the Omp native planner; `wouldSkipPlanning` (~:128-165); forwards `onUplift` (:76-77, :365). |
| `src/claude/hook.ts` | `runPromptSubmit` (:711): the stage pipeline shared by all hosts (see ordering below). |
| `hooks/uplift.ts` | Claude Code / Grok / Hermes-style hook CLI entry (stdout JSON, awaited `Bun.write`, `process.exit(0)` in `.finally` :262-275). NOT used by Omp. |
| `adapters/omp/commands.ts`, `adapters/omp/ports.ts` | Omp `CommandPort` adapter (declared flags `OMP_DECLARED_FLAGS` :31-38; routes commands needing `supports_slash_commands`, `supports_hooks`). Not the runtime hook path. |
| `src/host/omp-flight.test.ts`, `omp.test.ts`, `omp-test.helpers.ts`, `omp-endpoint.test.ts` | Flight/race tests (e.g. `omp-flight.test.ts:110-133` uses `request.onUplift?.(...)` with a gate promise). |
| `test/golden/omp/` (`capture.ts`, `fixtures/hook-*.json`, `registration.json`) | Golden captures of Omp hook events. |
| `conformance/omp-subject.ts`, `conformance/omp.conformance.test.ts` | Omp conformance subject. |
| `package.json:omp.extensions` / `pi.extensions` | Both point at `./src/host/omp.ts` - this is how Omp loads the plugin. |

There is no `hooks/omp*`, no `hosts/omp/`, and no `adapters/omp/index.ts`. Omp runs in-process as an extension (`export default createOmpExtension()`), not as an out-of-process hook.

### Stage order inside the planner (what is "generated" and in what order)
`src/claude/hook.ts` `runPromptSubmit`:
1. brief start :871; knowledge start :939
2. `uplift` stage start :949, `runUplift` :951 (`src/uplift/run.ts:37`) -> the uplifted XML spec.
3. If `think` is on: `deps.onUplift?.({ context: formatPromptContext(...) })` :1144-1145 (early hand-off, "uplift-only" context), then `stage("think","start")` :1149 -> `runThink` (GoT graph call, then per-node CoT fills, then repair pass).
4. `clarify` (HITL) :1261, `plan` (`buildTrackPlan`) :1320-1322, `track` (Linear/Notion rows) :1451-1455, `state` persist :1514, final `additionalContext` :1537.
So the "uplifted XML prompt" is not final until after think (graph injected into the XML, `injectGraphXml` `src/think/graph.ts:323`), plan and track.

### Most likely trigger of the bug (state as hypothesis, not reproduced)
`src/host/omp.ts` `before_agent_start` (:2816) races the planner against a timer:
- `raceMs` default 25_000 ms: `:1447`.
- Timer armed `:2903-2904`; `result = await Promise.race([flight.result, timeout.promise])` `:2923`.
- Planner is launched fire-and-forget: `plan({...}, signal, onEvent).then(flight.finishFlight, ...)` `:2650-2660` - the promise is intentionally not awaited by the handler.
- On timeout (`result === null`, `:2928`): `flight.deferred = true` `:2930`; if `flight.early` (set by `onUplift`, `:2654-2656`) the handler returns the uplift-only context as an inline message (`:2931-2941`, text "The rest of the plan follows as an aside ... until then, only read and investigate"); otherwise returns `pendingMessage()` (`:2943`, text `PENDING` at `:401-402`: "read and investigate only: no edits and no mutating commands").
- A returned `{message}` from `before_agent_start` lets Omp proceed to start the agent turn. Nothing blocks the turn: the "only read and investigate" restriction is advisory prompt text, not a gate. The model therefore starts executing while the XML/graph/tracking is still being generated.
- Late delivery: `settle` (`:2521-2553`) sends the plan with `pi.sendMessage(planMessage(...), { deliverAs: "aside" })` (`:2536-2547`). The comment at `:1775-1777` states `deliverAs: "aside"` starts a turn when idle, so the final plan can even trigger a second turn.
- Header comment `:6-11` documents this as intentional: Omp caps handlers at 30 s and drops late results (UT-Planning-ModelSelection 1.0.0 §7-§8).
Secondary candidates: `maybeAutoRun` returning early when a swarm lane spawns (`:2833-2850`, planner skipped), and `outer` deadline `maxRunMs` default 0 (`:1449`) meaning no cap on the flight itself.
Fix surface for the CompletionGate: the `result === null` branch `:2928-2944` and `settle` `:2521-2553`; `flight.early/earlyDelivered/deferred` fields (`:1495-1500`).

### Quick path
`/ultrathink-quick` arms `quick` and calls `pi.sendUserMessage(text)` (`:2353`); the `before_agent_start` quick bypass is at :2824-2840.

## (b) GoT / CoT stage modules, XML schema/validator, Sub Issue shape

| Path | Content |
|---|---|
| `src/think/types.ts` | `MIN_NODES=5`, `MAX_NODES=8` (:3-4); `MIN_STEPS=5`, `MAX_STEPS=8` (:7-8, "each step becomes one Sub-Issue"); `NodeKind` (8 kinds :10-18); `ThoughtNode {id,title,kind,question,dependsOn,thinking?,conclusion?,degraded?}` (:31-40); `ThoughtGraph {goal,nodes}` (:43-46); `THINK_ENGINES`, `ThinkConfig` (:64-75) with `fillRetries`, `repair`, `reasoningCeiling`; `FALLBACK_GRAPH` (:77). |
| `src/think/pipeline.ts` | `runThink` (:426). Graph call `buildGraph` (:198) with `GRAPH_SYSTEM_PROMPT`; CoT fill `attemptFill` (:227) with `COT_SYSTEM_PROMPT`, `fillNode` (:313), `fillLevel` (:341, per dependency level, parallel), `repairPass` (:392). `DEFAULT_FILL_RETRIES=2`, backoff 500 ms..8 s (:104-106). There is no separate CoT module: CoT = per-node fill in `pipeline.ts`. |
| `src/think/graph.ts` | `normalizeGraph` (:62), `isFallbackGraph` (:150), `topoSort` (:164), `dependencyLevels` (:208), `workflowWaves` (:238), `parseNodeFill` (:272, requires MIN..MAX numbered steps + closed conclusion), `graphToXml` (:311, `<GRAPH_OF_THOUGHT><GOAL>...`), `injectGraphXml` (:323), `graphSketch` (:339), `extractJsonObject` (:20). |
| `src/think/prompts.ts` | `GRAPH_SYSTEM_PROMPT` (:5), `COT_SYSTEM_PROMPT` (:40), `THINK_ADDENDUM` / `THINK_ADDENDUM_UNTRACKED` (:87, :90). |
| `src/uplift/xml.ts` | Uplift XML validator: `REQUIRED_CHILDREN` SYSTEM_ROLE, CONTEXT|APP_CONTEXT, SCOPE, CONSTRAINTS, ACCEPTANCE_CRITERIA (:9-16); `checkUpliftXml` (:134, returns `ok` / `unclosed_root` / `no_root` / `missing_child`); `sanitizeUpliftXml` (:153); `ensureOriginal` (:106); `escapeXml` (:22); `stripFences` (:31); `looksLikeUpliftXml` (:47). Root tags: `ROOT_TAGS` `src/types.ts:3` (BUILD_PROMPT, FIX_PROMPT, RESEARCH_PROMPT, ...; full list not read). |
| `src/uplift/run.ts` | `runUplift` (:37). `src/uplift/prompt.ts` holds the uplift system prompt (not read). |
| `src/track/plan.ts` | `buildTrackPlan` (:159): graph -> `TrackPlan`; `splitRationaleSteps` (:93); `nodeStepTitles` (:132); `linearSubIssues` (:150); `generateGraphId` (:33, `ut-<base36 time>-<uuid8>`); `MAX_UPLIFTED_PROMPT_CHARS=1900` (:22). |
| `src/track/types.ts` | Sub Issue data shapes: `SubIssueRow {graphId,nodeId,item,step,thought}` (:21-27), `LinearSubIssuePlan {nodeId,step,title,description}` (:36-42), `TrackPlan {graphId,task,issues,subIssues,linearIssues,linearSubIssues,hitl}`, `TrackingRefs` (:61-79) keyed by `stepKey(nodeId,step)=\`${nodeId}.${step}\`` (`src/track/create.ts:37`). A Sub Issue = one numbered rationale step of one node. |
| `src/track/render.ts` | `<ISSUES graphId status notionTaskUrl>` / `<ISSUE>` / `<SUBISSUE step=...>` XML (:39-49), `injectTrackingXml` (:62), `stripTrackingXml` (:93), `formatTrackingTodos` (:123). |
| `src/hitl/` | HITL clarify stage (`pipeline.ts`, `prompts.ts`, `types.ts`). |
No Tree-of-Thought code and no `CompletionGate` exist anywhere in `src`, `hooks`, `adapters`, `docs`, `services` (grep empty).

## (c) Linear and Notion writers

| Path | Role |
|---|---|
| `src/track/gateway.ts` | `createGatewayTracker` (:56): builds MCP clients (Linear, Notion) from `config.linear.team` / `config.notion.dataSourceUrl`; returns undefined if neither set (:69); calls `createTracking` (:125). `trackCommand` (:159) = `bin/ultrathink-mcp track complete`. |
| `src/track/create.ts` | The real writer: `createTracking` (:786). Tools: Linear `save_issue` (:1163; `blockedBy` link repair :1255-1259), `list_issues` read-back `{query:"ultrathink graph <id>", limit:250}` (:619); Notion `notion-fetch` schema (:1320), `notion-query-data-sources` (:700), `notion-create-pages` (:1366). |
| `src/mcp/notion-db.ts` | Creates the "Agent Task Graph" DB: `DEFAULT_TASK_GRAPH_TITLE` (:12), `taskGraphDdl` (:111), `notionPageId` (:131), `initTaskGraphDatabase` (:156), `writeNotionConfig` (:196). Other MCP plumbing: `src/mcp/client.ts`, `oauth.ts`, `store.ts`, `providers.ts`, `relay.ts`, `cli.ts`. |
| `src/host/grokbot-track.ts` | Grok Bot (Desk Lead) path: `buildTrackPayloads` (:82) runs the real `createTracking` against recording callers (`PEND-<n>` placeholders; Notion `pending-<n>` urls), `recordRefs`, `graphRegisterPayload` (:319, Substrate `graph_register`, idempotent by `graph_id`). |
| `src/claude/state.ts:534-563` | `mergeTrackingRefs` + checkpoint mutation (`onRef`): refs saved per row so a killed flight keeps rows made so far. |

Retry/backoff: `src/resilience/retry.ts` `withRetry` (:186): full jitter `random()*min(capMs, baseMs*2^(n-1))` raised to `Retry-After` (:212-213), `RETRY_AFTER_CAP_MS=120_000` (:8); permanent text classifier `PERMANENT_TEXT` (:34); 408/425/429/>=500 transient (:122). Tracker policy: `{maxAttempts:3, baseMs:500, capMs:8000}` `src/track/create.ts:100`; Linear-link wait for Notion rows `LINK_WAIT_MS=20_000` (:102); provider breaker on auth/permission/quota (header :7-9, `QUOTA_TEXT` :106).
Idempotency: header `create.ts:11-14` - creates have no idempotency key; on an uncertain failure it reads back the tracker for the row before any repeat (:901-925); a re-run adopts rows via `existing` TrackingRefs and by title match (`adoptLinear`, `adoptNotion`, :1005, :1027); Linear dedupe query by `ultrathink graph <graphId>` (:619). Pending Linear blocks are repaired via `pendingLinks` (:811, :1248).
Size limits: `FIELD_CAPS` `src/resilience/limits.ts:14-24`: title 160, goal 600, question 3000, thinking 8000, conclusion 26000, step 600, predecessor 3000 (head 1800/tail 1000). Notion `Item` clipped by title/step caps (`create.ts:263`, :277); Notion Description/Thought use `FIELD_CAPS.conclusion` / `.thinking` (:1409, :1445, :1491); `MAX_UPLIFTED_PROMPT_CHARS=1900` for the Notion rich-text property (`src/track/plan.ts:21-22`, comment says Notion limit ~2000). `clip` (`limits.ts:44`).
Config: `linear.team`, `notion.dataSourceUrl`, `track.{enabled,budgetMs=0,concurrency=6}` (`src/config.ts:101-132`); repository (project-layer) files cannot set tracker targets (`config.ts:1093`).

## (d) Provider detection, selected-model plumbing, hard-coded Haiku ids

| Path:line | Fact |
|---|---|
| `src/route-defaults.ts:14-18` | `ROUTE_DEFAULT_MODELS` frozen: claude `claude-haiku-5-5`, grok `grok-build-0.1`, muse `muse-spark-1.3-contributor`. |
| `src/config.ts:56,92` | `DEFAULT_CLAUDE_CONFIG.model = ROUTE_DEFAULT_MODELS.claude`; `modelProvenance` route-default / file-pin / explicit-blank (:212-213, :249); `HostModelOverride {provider,model}` (:195); `models.hosts`, `models.providerDefaults` (:207-210, merge :524-541); `think.reasoningCeiling` default "inherit" (:271). |
| `src/host/memory-chain.ts:21-22` | `MEMORY_CHAIN` primary `claude-haiku-5-5`, fallback `grok-build-0.1`, pinned in code, "no config key changes them"; `assertMemoryChain` (:58), `memoryChainFor` (~:102). |
| `src/env-registry.ts:553-556` | `ULTRATHINK_PLANNING_MODEL` default `claude-haiku-5-5` (hosted service planner). Service side: `services/ultrathink/engine/*` (tests assert `planningModel: "claude-haiku-5-5"`; `services/ultrathink/config/config.ts` not read - ASSUMPTION it reads that env). |
| `src/doctor/inference-check.ts:26-31` | `CLAUDE_MIN_VERSIONS` table: haiku 2.1.293, sonnet 2.1.284, opus 2.1.280 (ids `claude-haiku-5-5`, `haiku`, ...). `checkInference` (:386). |
| `hooks/engine.ts` | Hook-side engine; `hooks/engine.test.ts:256-260` expects `--model claude-haiku-5-5` when model undefined (source line not read). |
| `src/host/engine.ts` | `selectEngine` (:620), `selectJudgeEngine` (:797), `selectNativeEngine` (:899) + `NativeModelQuery` (:849) + `ModelIntent` (:142); `HOST_DEFAULT_ENGINES` per host (:178); `engineForSessionModel` (:592, matches substring claude/anthropic etc.); `ModelResolution` (:92, only allowlisted projection that crosses boundaries); `engineLabel` (:990). Header :17-19: Grok session tries Grok first, Claude last. |
| `src/host/omp.ts` | Omp is native: live Model snapshot `observeLive`, `snapshotModel`, `LiveTarget`; `completeSimple` from `@oh-my-pi/pi-ai` (:823-829); provider default table `DEFAULT_MODEL_PER_PROVIDER` from `@oh-my-pi/pi-catalog/provider-models` (:571-577) -> `config.models.providerDefaults` (:1351); native retry `RETRY_POLICY {3,2000,8000}` (:612); `OmpPlanRequest.model/modelSource/thinkingLevel/native` (:332-336 area). |
| `src/failover/chain.ts` | `createFailoverCompleter` (:131) over `FailoverCandidate {id,label,complete}` (:24); `classify.ts` plan-limit/quota classification. No model ids hard-coded there (grep haiku empty). |
| `src/host/detect.ts:17` | `detectHost(env)`: `ULTRATHINK_HOST` override, then env markers per host (GROK_*, MUSE_*, PRIME_AGENT_*, CLAUDE_PLUGIN_ROOT, ...). |
| `src/host/types.ts:7-15` | `HOSTS = claude-code, grok-build, hermes, muse, omp, prime-agent, cursor`. |
Cheapest-model routing hook points: `ROUTE_DEFAULT_MODELS`, `models.providerDefaults`, `think.reasoningCeiling`, `selectEngine` `purpose` field (planning | memory | auxiliary | judge). A catalog-based "cheapest" selection does not exist.

## (e) Plugin manifests and install layout

| Path | Host / role |
|---|---|
| `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` | Claude Code plugin + marketplace (v1.4.0). |
| `hooks/hooks.json` | Claude Code hooks: UserPromptSubmit -> `bin/run-bun hooks/uplift.ts` (timeout 86400), PostToolUse (answers.ts, pr-sync.ts, flow-eval.ts), Stop -> stop.ts. Commands use `${CLAUDE_PLUGIN_ROOT}`. |
| `.omp-plugin/marketplace.json` | Omp marketplace manifest (source "./"). Omp entry also via `package.json` keys `omp.extensions` / `pi.extensions`. `.omp/config.yml` local. |
| `.muse-plugin/plugin.json` | Muse manifest (skills, commands, hooks `hooks/muse-prompt|muse-post-tool|muse-stop` with timeoutMs 600000/10000/5000). |
| `.cursor-plugin/plugin.json` | Cursor plugin: `skills ./skills/`, commands `./hosts/cursor/commands`, `./hosts/cursor/gsd-commands`; `hosts/cursor/ultrathink-cursor-plan.js`; `scripts/cursor-plugin.ts`, `scripts/cursor-hooks.ts`. |
| `hosts/hermes/plugin.yaml`, `bridge.py`, `__init__.py` | Hermes (Python bridge, `bridge_test.py`). |
| `hosts/prime-agent/SKILL.md`, `src/ultrathink/__init__.py` | Prime Agent (skills-only). |
| `hosts/grok/ultrathink.md`, `hosts/grok-bot/skills/*/SKILL.md` | Grok Build / Grok Bot (Desk Lead) skills. `bin/ultrathink-grokbot`. |
| `skills/ultrathink-{plan,cursor,kickoff,teach,ship,sync}/` | Shared skills (listing partially read). |
| `plugin/source/plugin.source.yaml` | Source of truth for generated manifests (hosts: claude-code, muse, omp, hermes verified; prime-agent, grok-build unmapped). |
| `plugin/hosts/<host>.map.yaml` | Per-host mapping (claude-code, hermes, muse, omp). |
| `plugin/generated/<host>/manifest.json` | Generated (claude-code, hermes, muse, omp). Generator `tools/gen-manifests/generate.ts` (`bun run gen:manifests`); CI fails on drift (`.github/workflows/ci.yml:131-136`). Schema `plugin/schema/plugin-source.schema.json`, validated by `tooling/schema/validate.ts`. |
| `adapters/install.ts` | Host-neutral transactional install engine (`installPlugin` :54: stage, rename, registrations, rollback, `.ultrathink-install.json`). `adapters/cli.ts`, `adapters/version-floor.ts`, `adapters/capability-gate.ts`; per-host `adapters/{omp,claude-code,grok-build,hermes,muse,prime-agent}/` (index.ts / commands.ts + README + tests; `prime-agent/install.ts`). `bin/ultrathink-adapter`. |
| `core/src/{capabilities,ports}/` | Host-neutral ports (`command.ts`, `environment.ts`, `injection.ts`, `lifecycle.ts`, `sync-filesystem.ts`, `capabilities/manifest.ts`); boundary rule `tooling/boundary/check-core-boundary.ts`. |
| `conformance/<host>-subject.ts` + `*.conformance.test.ts`, `suite.ts` | Per-adapter conformance. |
| `plugins/ultrathink-connector/` | Claude-style connector plugin (`.claude-plugin/plugin.json`, `.mcp.json`, `commands/`, `skills/`, `package.sh`). `plugins/omp-token-opt/` separate Omp extension package. |
| `ultrathink.discovery.json` (+ schema), `scripts/setup.ts`, `scripts/mcp-register.ts` | Discovery manifest, setup, MCP registration. |
| `docs/validation/results/{omp,claude-code,grok-build,hermes,muse,prime-agent}.md`, `minimum-host-versions.md`, `docs/plugin-research/` | Per-host validation evidence. |
The repo's host set (`src/host/types.ts`) has 7 hosts; the GSD-Core supported-CLI list is not in this repo (ASSUMPTION: it must be sourced externally).

## (f) Test runner, scripts, state/checkpoint dirs

- Runner: Bun (`engines.bun >=1.2`), `bun test`; tests colocated `*.test.ts`; `src/test.setup.ts`, `src/test.helpers.ts`, `src/test.state-dir.ts` shared helpers; `services/ultrathink/test.helpers.ts` `makeTempDir`. CI `.github/workflows/ci.yml:126-127`: `bun test` with `ULTRATHINK_SMOKE_SERVICE=1`; conformance matrix `bun test conformance --test-name-pattern`.
- `package.json` scripts: `test`, `check` (tsc 5.9.3 noEmit), `check:services`, `lint` (`biome check --error-on-warnings .`), `format`, `deadcode` (`knip --include exports,types`; entries in `knip.json`, notably `src/host/omp.ts`), `verify` (check+lint+deadcode+test+both Python bridge tests), `hook:uplift`, `uplift`, `setup`, `mcp`, `chaos`, `ship`, `policy:check`, `policy:collect`, `gen:manifests`, `compliance`.
- Style: Biome 2.6.4, tabs, double quotes, `.ts` import extensions (per task brief; `biome.json` not read).
- State dir per host: `src/host/paths.ts:24-52` - omp `${PI_CODING_AGENT_DIR||~/.omp/agent}/ultrathink`; claude-code `${CLAUDE_CONFIG_DIR||~/.claude}/ultrathink`; grok-build `${GROK_PLUGIN_DATA}/ultrathink` or `~/.grok/plugin-data/ultrathink`; hermes `${HERMES_HOME||~/.hermes}/ultrathink`; muse `${XDG_CONFIG_HOME||~/.config}/muse/ultrathink`; prime-agent `${PRIME_AGENT_CODING_AGENT_DIR||~/.prime/agent}/ultrathink`; cursor `~/.cursor/ultrathink`. `ULTRATHINK_STATE_DIR` override accepted only if absolute, inside home, not a planning tree (:6-9, `resolveStateDirDetail` :83).
- Files inside: `control.json` (`src/claude/state.ts:115`), `sessions/<id>.json` (:233), `sessions/<id>.skip` (:281), `last.json` (:446), plan carrier `last-plan.<sessionId>.json` (`src/host/carrier.ts`, per `hooks/uplift.ts:234`), per-session `.xml` spec file (referenced by `src/track/plan.ts:24`). Tracking checkpoint = `SessionRecord.tracking` merged by `mergeTrackingRefs` (`state.ts:534`); locked via `updateSession` (:479). Server-side checkpoints: `services/ultrathink/store/checkpoint.ts` (not read).
- User config: `${XDG_CONFIG_HOME||~/.config}/ultrathink/config.json` (`src/config.ts:1124`); layers via `claudeConfigPaths` (:1137).
- Repo-planning dirs (not product state): `.planning/`, `.swarm/`, `.gsd/`.

## Placeholder -> real path

| Placeholder (from plan) | Real path |
|---|---|
| `src/host/omp-*.ts` (hook/command) | `src/host/omp.ts` (hook+commands); UI siblings `omp-ui.ts`, `omp-render.ts`, `omp-insights*.ts` |
| `hooks/` Omp hook | none; Omp is in-process extension (`package.json` `omp.extensions` -> `src/host/omp.ts`) |
| `hosts/omp`, `adapters/omp/index.ts` | none; `adapters/omp/commands.ts`, `adapters/omp/ports.ts` |
| CompletionGate module | none yet; suggested integration `src/host/omp.ts` `before_agent_start` :2816-2950 + `settle` :2521 (new file e.g. `src/host/completion-gate.ts`: ASSUMPTION) |
| GoT stage | `src/think/pipeline.ts` (`runThink`), `src/think/graph.ts`, `src/think/prompts.ts` |
| CoT stage | per-node fill in `src/think/pipeline.ts:227-340` + `COT_SYSTEM_PROMPT` `src/think/prompts.ts:40` |
| ToT stage | none; stage hooks in `src/claude/hook.ts` between think (:1149) and clarify (:1261) |
| XML schema / validator | `src/uplift/xml.ts` (`checkUpliftXml` :134), `src/types.ts:3` `ROOT_TAGS`, `src/think/graph.ts:311-323`, `src/track/render.ts` |
| Sub Issue shape | `src/track/types.ts:21-42`, built in `src/track/plan.ts:150-197` |
| Linear writer | `src/track/create.ts` (`save_issue` :1163), `src/track/gateway.ts` |
| Notion writer | `src/track/create.ts` (`notion-create-pages` :1366), `src/mcp/notion-db.ts` |
| `src/host/grokbot-track.ts` | same path |
| `src/config.ts`, `src/env-registry.ts` | same paths (`src/route-defaults.ts` added) |
| `src/failover/` | `src/failover/chain.ts`, `classify.ts` |
| `src/doctor/inference-check.ts` | same path |
| PRD output dir | none; ASSUMPTION new files under state dir `sessions/` or `docs/prd/` |
| plugin dirs | `plugin/` (source/hosts/generated/schema), `plugins/` (connector, omp-token-opt), `.claude-plugin/`, `.omp-plugin/`, `.muse-plugin/`, `.cursor-plugin/`, `hosts/`, `adapters/`, `core/`, `conformance/` |
| Cursor/Grok/Hermes/Prime install | `scripts/cursor-plugin.ts`, `hosts/hermes/`, `hosts/prime-agent/`, `hosts/grok/` |

## ASSUMPTIONS
1. The 25 s race in `src/host/omp.ts:1447/2903-2943` is the cause of the early session start; not reproduced or run. Omp host semantics (returned `{message}` lets the turn proceed; `aside` starts a turn when idle) taken from in-repo comments (:6-11, :1775-1777), not Omp source.
2. `omp.ts` lines 2316-2440 and 2564-2600 were only skimmed; other early-return paths in the handler (e.g. `wouldSkipPlanning` :2868) were not traced for this bug.
3. GSD-Core's supported CLI list is not in the repo; packaging scope for workstream 3 needs an external source.
4. `services/ultrathink/config/config.ts` reading `ULTRATHINK_PLANNING_MODEL`, `hooks/engine.ts` default model line, `ROOT_TAGS` full list, `src/uplift/prompt.ts` content, `src/types.ts` rest, `biome.json`, `bunfig.toml` (if any) were not read.
5. Whether Notion enforces a 2000-char rich-text cap on `Description` (given `FIELD_CAPS.conclusion` 26000 is passed, `create.ts:1409`) was not verified; only the code comment `src/track/plan.ts:21` states it.
6. New-file names suggested for CompletionGate / ToT / PRD output are proposals, not existing paths.
7. Skills dir listing (`skills/`) and `docs/` contents beyond `validation/` and `plugin-research/` were truncated by the listing tool.
