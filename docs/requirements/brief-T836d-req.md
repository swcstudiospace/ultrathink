# Cleaned Brief: T836d-req (redacted)

- Source: task.assign brief, correlation 836dc01d-3bcb-4957-982f-95d75b1b9593
- PII scan: found [] has_pii false regimes_hint []
- Ambiguity: score 0 terms [] needs_clarification false (6 sentences)

## Redacted brief

Upgrade claude-ultrathink uplift quality and Omp UI density at production grade. Keep existing Uplifted Prompt UI and add complete uplifted prompt underneath. Add Substrate, Knowledge, Skills, Lessons, Teachable Moments panels wired to real stores with no stub panels. Restore 6-8 Graph-of-Thought nodes with one full Chain-of-Thought per node. Uplifted prompt includes Linear Issues plus Sub-Issues and Notion links. Dense defaults: per-node steps at least 5, each step a Sub-Issue, maxChars raised so no truncation in normal mode. Existing Uplifted Prompt section unchanged; second section renders complete prompt beneath. Full local verification green (bun run check, bun test, biome, knip); open PR to main; CI green before merge. Linear and Notion updated.

## Stakeholders and constraints

- Michael: dense defaults 6-8 nodes; per-node steps at least 5; no truncation in normal mode; existing section unchanged; no stub panels; kickoff retains row creation; .planning authoritative for sync.
- Constraints grounded in repo: src/think/pipeline.ts runThink (1 graph call, topoSort, bounded CoT fills plus retry), src/think/prompts.ts, src/uplift/prompt.ts, src/uplift/xml.ts, src/host/omp-graph.ts, src/claude/output.ts formatPromptContext, src/think/types.ts MIN_NODES 5 MAX_NODES 8 MIN_STEPS 5 MAX_STEPS 8.
- Open questions: maxChars exact value to be set by implementer to satisfy AC-42; CI merge policy is CI-green (review unavailable) per brief.

