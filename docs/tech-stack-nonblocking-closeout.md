# Tech Stack Selection: Non-blocking Closeout (Tf0b0-arch)

- Correlation: f0b0e21f-f469-46da-9609-3c4030a11d7f
- Decision level: L2 (catalog-pattern, no novel infrastructure, no new first-party dependency)
- NFR-12: 0 new first-party dependencies, AGPL retained for 100% of changed files

| Concern | Choice | Golden path or ADR | Supply-chain |
|---------|--------|-------------------|--------------|
| Runtime | Bun + TypeScript (existing host `src/host/omp.ts`, `package.json` `omp.extensions`) | Existing golden path; no catalog miss; no ADR needed | SBOM required; OSV feed unknown (no scan evidence, marked unknown) |
| Datastore | File JSON `phase-loop-store` / `plan-store` (existing) | Existing; no new infra | Allowlist: no additions; licence AGPL-3.0-or-later unchanged |
| Messaging | Aside delivery via host `sendMessage`/`appendEntry` (existing) | Existing; no new service | No new service; SBOM unchanged |
| Auth | Host `ExtensionAPI` (existing) | Existing | No new auth surface |

No environment or infrastructure change is proposed to A11. A10 dependency review: 0 new dependencies, licence matrix unchanged, no security-risk acceptance (A10 only).

Validation: `arch_nfr_allocation` 5/5 fully_allocated=true (NFR-08 5000 ms, NFR-09 0 findings, NFR-10 0 violations, NFR-11 0 violations, NFR-12 0 deps).
