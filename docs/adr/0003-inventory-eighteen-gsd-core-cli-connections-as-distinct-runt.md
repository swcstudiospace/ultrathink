# ADR-0003. Inventory eighteen GSD-Core CLI connections as distinct runtime ids

- **Status:** accepted
- **Date:** 2026-11-16
- **Deciders:** A03
- **Task:** Tab6a-arch

## Context and Problem Statement

US-3 requires 18 connected lines for the GSD-Core CLI set in requirements.spec 1.0.0 section 4. vscode is not CLI-installable. gemini is retired. omp is not a GSD-Core runtime. package.json maps both pi and omp extensions at the same file, so id equality must not be inferred from the file.

## Decision Drivers

US-3; US-4; AC-13 to AC-20; assumption A-3 and A-4; NFR-I1.

## Considered Options

- Treat the README marketing list as the set
- Treat a pi load as an omp load
- Inventory the 18 ids as distinct connection slots and refuse gemini

## Decision Outcome

Chosen option: "Score connection only against the fixed 18 GSD-Core CLI runtime ids, keep pi and omp distinct, exclude vscode, and refuse gemini with GSD_RETIRED_RUNTIME.".

### Positive Consequences

- The required set size stays 18. vscode cannot inflate it. gemini cannot enter it. A pi pass cannot satisfy omp, and omp is not required.

### Negative Consequences

- Twelve runtime ids have no Ultrathink entry in this repository. They report PLUGIN_AGENT_MISSING until A05 loads an entry. This ADR does not invent their install commands.

## Consequences

A05 adds entry slots for ids with no Ultrathink entry. Until an entry is loaded the inventory returns PLUGIN_AGENT_MISSING. Ship still waits for one operator confirmation. No new runtime host is added to GSD-Core.
