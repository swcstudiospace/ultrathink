# ADR-0008. Workflow drives poteto playbooks via shared fleet resolver

- **Status:** accepted
- **Date:** 2026-11-23
- **Deciders:** A03
- **Task:** T3b18-arch

## Context and Problem Statement

FR-1 requires gsd-autonomous to drive poteto-mode playbooks. The resolver chain src/cursor/pstack.ts -> src/pstack/subagents.ts already exists and the hook renders its roster; a second resolver would drift (AC-41 forbids it). The brief shorthand discuss=how names the how roster skill, not a playbook: the discuss playbook is investigation per PLAYBOOK_ROUTES.

## Decision Drivers

- FR-1/AC-41..AC-43; reuse over duplication
- poteto-autonomous ownership: GSD keeps TodoWrite/.planning/verify

## Considered Options

- gsd-autonomous dispatches PLAYBOOK_ROUTES playbooks through resolveSubagentFleet, no second resolver

## Decision Outcome

Chosen option: "gsd-autonomous dispatches PLAYBOOK_ROUTES playbooks through resolveSubagentFleet, no second resolver".

- Single resolver keeps DEFAULT_MAPPING, PLAYBOOK_ROUTES and roster format identical for hook and workflow.
- poteto-autonomous stays the runner; only its fleet gate is bound to the workflow.
- Workflow edit is markdown-only, no new dependency (NFR-22).
- A05 must keep grep-resolvePstack-outside-two-modules at 0; workflow install path (~/.agents/gsd-core) needs A11 verification.
TBD — note follow-up tasks for A05/A06/A07/A11.
