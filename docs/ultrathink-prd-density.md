# Ultrathink PRD Density — Blocked-Evidence Accounting (N4 local-only)

**Task:** T0175-linear-prd-density (correlation 0175ffa9-9918-483f-83c9-49ea421aeb28)
**Lane:** N4 (SPE-35031) — local-only per user answers q1=Fix then execute all,
q2=Generate plan locally, q3=Local-only queued sync. No live Linear/Notion
writes in N4. This file is included in this PR as local-only
blocked-evidence accounting (density 0.0, live sync blocked), **not success**.

**Status: BLOCKED on integration (live Linear/Notion application) — density 0.0, required 1.0**

## Parents (graph ut-c651ac1843-98c0c5bd — from .swarm/plans/0175ffa9-9918-483f-83c9-49ea421aeb28.json)

- SPE-35029 [n3] Compare Plan gate designs (design B: Hard State-Machine Plan Gate)
- SPE-35031 n4 PRD+Notion linkage spec (steps SPE-35054..SPE-35056)
- SPE-35032 n5 aggregate state rules
- SPE-35033 n7 Synthesize wave-ordered execution plan (steps SPE-35075..SPE-35081)

Sub-issue census range: SPE-35034..SPE-35081 (per-issue status and team unverified in this PR).
Graph fit: parents + steps named above; full per-issue enumeration requires
`linear list_issues` with `parentId` per parent — **blocked** (see evidence).

## N4 local working rules (workspace-only — not included in or reviewable from this PR)

No claim is made from this PR that git-ignored workspace artifacts exist
in this PR. Any local artifacts are workspace-only and not reviewable
from this PR, and are not claimed as tracked repo files. This density
doc itself is included in this PR as local-only blocked-evidence
accounting. Their working rules are summarized inline so this committed
doc stands on its own:

- Local-only template working rules (workspace label:
  `.planning/templates/codeblocked-prd.md`, if present locally): gsd-prd
  fenced template: identity first line `PRD-ID | Parent | Version | Hash`,
  fixed 12 headings in order (Objective; Current State; Scope / Out of
  Scope; Named Surfaces; Data/API Contracts; Dependencies; Implementation
  Steps; Validation/Test Plan; Acceptance Criteria; Risks;
  Rollback/Degradation; Traceability), idempotent hash/no-op/supersede
  rules, sync direction (Linear = state/labels/completion; Notion =
  prompt/planning; only URLs, status summary, Hash flow), round-trip
  verification.
- Local-only density definition (workspace label:
  `.planning/prd-density.md`, if present locally): see Density math
  below, which is the operative inline definition.
- Local-only sync queue (workspace label: `.planning/sync-queue.md`, if
  present locally): queued inventory, 48 rows, 0 applied; rows stay
  queued (no live Linear/Notion writes in N4).

## Density math

```
density = PRD-complete / total-generated-sub-issues
total = 48 (SPE-35034..SPE-35081 inclusive)
PRD-complete = 0 (live Linear PRD + round-trip verified; N4 did no live writes)
density = 0/48 = 0.0; required = 1.0; gap = 48
```

Denominator and queue are spec-range only. Parent mapping verified only for
SPE-35054..SPE-35056 (n4 steps) and SPE-35075..SPE-35081 (n7 steps); all other
rows mark parent/Notion link `unverified — fill on integration`. Census
expansion is blocked-on-integration; no IDs/titles invented beyond the range.
The superseded old template fragment is removed; the template described
above is, if present locally, a workspace-only artifact not reviewable
from this PR and not a tracked repo file. Existing Linear description
text and the graph/node/step footer remain preserved by rule (append,
never replace).

## N4 evidence (local-only, this lane)

- No claim is made from this PR that git-ignored workspace artifacts
  exist in this PR; any local artifacts are workspace-only and not
  reviewable from this PR. This density doc, by contrast, is included
  in this PR.
- No live Linear/Notion transport attempted (q3 local-only); no IDs, titles,
  or parent mappings invented beyond the spec range SPE-35034..SPE-35081.
- No tests/lint/typecheck/formatters run in this doc lane; no commit (per
  assignment). No targeted-test existence or result claim is proved by
  this diff, and none is claimed here.
- Prior MCP/human-approval blockers below are retained as blocked-evidence
  history, superseded for live-write purpose by N4's local-only scope.

## Evidence log

- MCP enumerate (`xd://mcp__linear_list_issues`, parentId + query): BLOCKED —
  `BLOCKED needs: human-approval (mcp: xd://mcp__linear_list_issues)` ×5 calls.
- Notion writability test (`xd://mcp__notion_fetch` on known page
  41dbc1a0-c7ae-818b-888e-fbd8b2181504): BLOCKED — same human-approval gate fires
  before any read/write, so the Phase-114 criterion-7 403 test cannot run yet;
  neither outcome can be claimed.
- Shell (`bash` probe of repo state): BLOCKED — `swarm-assignment` lane rule
  (edit-only mid-flight); docs_bundle.py/docs_bundle.ts therefore recorded as
  skipped:tool-missing for this lane.
- Headings sanity of the template fragment above: h1 1, skips 0 (SUCCESS).

## Omitted sub-issues

None silently omitted: census incomplete, pending MCP access. Once unblocked,
every parent's children via parentId will be enumerated and any gap logged here.
