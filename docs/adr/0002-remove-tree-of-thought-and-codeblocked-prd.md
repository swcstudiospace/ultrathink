# ADR-0002. Remove Tree-of-Thought and Codeblocked PRD

- **Status:** accepted
- **Date:** 2026-11-22
- **Deciders:** A03
- **Task:** T1750-arch

## Context and Problem Statement

Codeblocked PRD/ToT stage introduced in cd2882d/656711e (#107) is to be removed; pre-ToT behavior (GoT+CoT) restored on feat/state-refresh-2026-11-25 at 2d9c1e2 without resetting to main e461875

## Decision Drivers

US-001..US-005 AC-1..AC-15; file-disjoint excision per slice

## Considered Options

- reset to main e461875 (rejected: discards v1.15-v1.24)
- keep PRDs with flag off (rejected: leaves dead surface)

## Decision Outcome

Chosen option: "Delete src/think/tot, src/track/prd-sync.* and prd-types.*, hook-tot.*, PRD blocks in hook.ts/omp.ts/completion-gate.ts, think.tot config and code-blocked-prds.md; restore pre-ToT GoT+CoT pipeline and CompletionGate without PRD verdicts".

### Positive Consequences

- Pre-ToT surface is the only think pipeline: GoT graph (buildGraph) plus CoT node fills (fillNode/repairPass), release on node completion.
- No PRD generation, PRD sync, or PRD presence verification remains anywhere in src/, hooks/, or docs.
- `git log` intro commits cd2882d/656711e remain in history (untouched); excision is a forward revert-by-surgery, not a rewrite.
- CHANGELOG history, runtime-install (bin/), and unrelated docs (v1.15-v1.24) are untouched.
- Transient loss of PRD content in Linear/Notion rows already written: not retroactively deleted; only future generation stops.
 
 ### Negative Consequences
 
- PRD text already synced into tracker rows becomes orphaned (never again updated or verified); downstream A05/A06/A07 must not re-add PRD UX.
- Any consumer still sending `think.tot` config will have it ignored like `models.tot` (doctor warning).

## Consequences

ToT and PRD sync code deleted; CompletionGate keeps 7 non-PRD verdict codes; phase-114 dir deleted, withdrawn annotations kept
