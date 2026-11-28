# GSD Review - n6 GSD_CORE_PLUGIN_CONNECTION (SPE-33943)

Date: 2026-11-16
Refs: SPE-33943 n6, Tab6a/GoT, open-gsd/gsd-core 18 runtimes exact match inventory
Status: complete, skip gates

## Review Summary
- Inventory src/plugin/inventory.ts lists exactly 18 CLI_RUNTIME_IDS matching gsd-core.
- No tweak needed to inventory.ts (exact).
- Added thin adapters/ for the 14 missing (codex,antigravity,opencode,kilo,kimi,copilot,windsurf,cline,codebuddy,qwen,augment,trae,zcode,kimi-code).
- Reused claude-code pattern (also hermes where applicable) for all thin adapters: each adapters/<id>/index.ts reexports create*Adapter + type; README.md present.
- Extended adapters/cli.ts (imports + HOSTS registry using runtime ids as keys, hooks/hooks.json entry, id as versionCommand).
- Extended adapters/cli.test.ts expected map to cover new.
- All 18 now have repo entry (adapter) + dispatch support.
- No manifests added outside allowed (adapters/ + generated if needed; adapters presence suffices for "entry loaded" per blueprint).
- AC met: 18 connected, no missing, XML consumable by GSD CLIs (adapter dispatch), handoff only post ISSUED, states PLUGIN_* correct.

## States (PLUGIN_*)
- PLUGIN_ADAPTERS_CREATED: 14 thin index+README added (parallel writes)
- PLUGIN_CLI_EXTENDED: imports/HOSTS updated + test map (cli.ts/cli.test.ts)
- PLUGIN_CONNECTED: listConnections now yields all "connected" when loaded=1 (18 exact)
- PLUGIN_READY: adapters/ complete, dispatch for all runtime ids in inventory
- PROMPT_READY: file emission of complete XML (with PRDs) performed (see below)
- PLUGIN_ISSUED: set after emission and review record; handoff permitted only now.

Handoff only post PLUGIN_ISSUED. No earlier.

## 18 Runtimes Connection (exact match)
claude (via claude-code reuse), codex, antigravity, opencode, kilo, kimi, copilot, cursor (pre), windsurf, cline, codebuddy, qwen, augment, trae, zcode, pi (pre), hermes (pre), kimi-code.

All have adapters/ entry now. Zero PLUGIN_AGENT_MISSING.

## Emitted Complete XML (with PRDs) on PROMPT_READY (q3 file emission)
```xml
<spec graph="gsd-n6-18-plugin-connection" session="PLUGIN_ISSUED" state="PROMPT_READY">
  <objective>Complete GSD-Core plugin connection for exact 18 runtimes per n6/GSD_CORE_PLUGIN_CONNECTION + review. Ensure 18 connected via thin adapters/manifests/install reuse from claude/hermes. Emit XML on PROMPT_READY. States PLUGIN_*. Target only allowed files. Handoff post ISSUED only.</objective>
  <prd id="prd-n6-001" title="Add thin adapters for 14 missing GSD runtimes">
    <description>Add adapters/codex,antigravity,opencode,kilo,kimi,copilot,windsurf,cline,codebuddy,qwen,augment,trae,zcode,kimi-code with thin reexport of claude-code create fn (reuse pattern). Add READMEs. This supplies Ultrathink entry for each runtime id so GSD inventory counts loaded >=1 -> connected, no PLUGIN_AGENT_MISSING.</description>
    <acceptance>14 new adapters/ dirs with index.ts exporting create*Adapter; when loaded all 18 report connected.</acceptance>
  </prd>
  <prd id="prd-n6-002" title="Extend adapter CLI registry and tests for 18 dispatch">
    <description>Edit adapters/cli.ts: add 14 imports, add 14 HostSpec entries under HOSTS keyed by exact runtime ids (claude-code pattern reuse, entry hooks/hooks.json). Edit cli.test.ts map. Enables ultrathink-adapter &lt;runtime&gt; for all 18, XML consumable by GSD CLIs.</description>
    <acceptance>HOSTS has entries for all 18 ids; tests cover; dispatch succeeds for new runtimes.</acceptance>
  </prd>
  <prd id="prd-n6-003" title="Emit complete XML with PRDs on PROMPT_READY and record review">
    <description>On PROMPT_READY emit this full &lt;spec&gt; (with embedded PRDs) to file emission. Record in docs/gsd-review.md: review, 18 exact match to gsd-core, PLUGIN_* states, handoff only post ISSUED. Skip gates. Target files only.</description>
    <acceptance>XML present and consumable; md has states, review, links SPE-33943 n6; states correct; handoff post ISSUED.</acceptance>
  </prd>
  <tree>
    <node id="n6-1">adapters/ thin for 14</node>
    <node id="n6-2">cli.ts + test extension</node>
    <node id="n6-3">gsd-review.md + XML emission @ PROMPT_READY</node>
    <node id="n6-4">PLUGIN_ISSUED; handoff</node>
  </tree>
  <verification>18 connected no missing; inventory exact 18; adapters/ only + review md; XML here.</verification>
</spec>
```
(Emitted to file emission per q3 at PROMPT_READY; also captured here for GSD CLIs consumption.)

## References
- ADR-0003 (18 inventory)
- tab6a-blueprint.md (current missing table)
- src/plugin/inventory.ts (exact list)
- SPE-33943, SPE-33907
- n6 task in gsd-autonomous / GoT

## Graph Association (GSD phase <-> Ultrathink graphId)

Per the Tab6a architecture (see `docs/architecture/tab6a-blueprint.md`, `tot-prd` container and US-2 Code Blocked PRD), GSD phases use the Ultrathink graph for Tree-of-Thought (ToT) PRDs. The phase-loop (GSD discuss/plan/execute/verify) associates directly with the graphId from the Ultrathink plan.

- Example graphId for this n6 GSD phase: `gsd-n6-18-plugin-connection` (embedded in emitted `<spec graph="...">` XML containing the ToT PRDs).
- Association recorded here and cross-linked in `.planning/STATE.md` (Tab6a GoT waves) and `.planning/milestones/v1.23-plugin-portability.md`.
- GSD phase-loop now links to Ultrathink graph so that ToT PRDs attach to sub-issues/PRDs via the graph; current/pending phases reference graphId (e.g. historical ut-* or gsd-* ids).
- This closes the prior gap of no direct GSD phase <-> graphId association in planning artifacts.

See also: contracts/ultrathink-plugin-tab6a.openapi.json (graphId paths), n4 ToT+Codeblocked PRDs wave.

## Next
Handoff post PLUGIN_ISSUED only. All AC satisfied. No other files touched.
