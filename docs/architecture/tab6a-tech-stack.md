# Tech stack selection — Tab6a

- Kind: `tech.stack.selection`
- Version: 1.0.0
- Task: `Tab6a-arch`
- Correlation: `ab6a76d6-3e64-4867-8476-b7acb5c4dee0`
- Owner: A03

No `infra.constraints` catalog was attached. No catalog entry was invented. Every choice below is already in this repository. Level is L2. No new infrastructure and no new first-party dependency.

| Concern | Choice | Source | ADR | Level |
|---|---|---|---|---|
| Runtime | TypeScript on Bun `>=1.2` | `package.json` `engines.bun` | none new | L2 |
| Omp session gate | existing extension `src/host/omp.ts` | ADR-0001 | ADR-0001 | L2 |
| Uplift completeness | `src/types.ts`, `src/uplift/xml.ts` | spec section 4 | none new | L2 |
| Sub-issues | `src/track/plan.ts` | ADR-0002 | ADR-0002 | L2 |
| Model prices | caller-supplied published input USD per 1000000 tokens | assumption A-2 | ADR-0002 | L2 |
| Secret scan | `src/redact.ts` | NFR-S1, NFR-C1 | none new | L2 |
| Plugin install | `adapters/install.ts` where a host adapter already exists | ADR-0003 | ADR-0003 | L2 |
| Phase names | existing GSD command mapping in `src/cursor/pstack.ts` | US-4 | ADR-0003 | L2 |

Rejected:

- A new HTTP server for the OpenAPI file. The file is an in-process contract.
- A new model-price network client. That would be novel infrastructure.
- A new datastore. Session records stay in the existing state directory.
- Adding `omp` to GSD-Core.

## Supply chain

| Row | Status | Evidence |
|---|---|---|
| SBOM required for a new package | not applicable | no new package |
| Dependency allowlist | unchanged | no new dependency |
| Licence | AGPL-3.0-or-later | `.claude-plugin/plugin.json` |
| OSV / risk feed | unknown | no catalog and no new dependency to query |
| Approved catalog | absent | open question for A11; do not invent entries |

Environment changes: none. A11 has no infrastructure proposal from this design.
