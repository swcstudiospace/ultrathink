# NFR bindings — Tab6a-arch

Correlation: `ab6a76d6-3e64-4867-8476-b7acb5c4dee0`
Version: 1.0.0
Source: `docs/requirements/nfr.md` 1.0.0. Ids are unchanged.

`arch_nfr_allocation` returned `fully_allocated: true`, `coverage_pct: 100`, `nfr_count: 5`, `unallocated: []`, `unmeasurable: []`, `unknown_nfr_ids: []`.

No policy default was applied. Every limit is the number in the NFR. `assumed` is false on every row. No p95 of 300 ms was invented. The public-API default does not apply: this contract is in-process.

| NFR | Kind | Binding | Limit | Unit | Assumed |
|---|---|---|---|---|---|
| NFR-P1 | quantitative | component budget `omp-session-gate.timeout_failure_events` | 0 | events | false |
| NFR-S1 | quantitative | clause `UpliftDelivery` `x-secret-scan-matches` | 0 | matches | false |
| NFR-A1 | quantitative | component budget `omp-session-gate.status_chars` | 200 | characters | false |
| NFR-I1 | quantitative | clause `ErrorCode.maxLength` | 40 | characters | false |
| NFR-C1 | quantitative | clause `CodeBlockedPrd` `x-secret-scan-matches` | 0 | matches | false |

NFR-P1 also requires 1 complete-uplift delivery when 300000 ms ≤ T ≤ 600000 ms. That count is `UpliftDelivery.delivered` maximum 1. The failure budget is the max-0 timeout-failure events above.

NFR-A1 also requires an integer second count and forbids color as the only waiting-versus-failed signal. Those are in the session-gate status rule in the blueprint. The measurable limit is 200 characters.

NFR-I1 also requires the four codes `UPLIFT_WAIT_EXCEEDED`, `PRD_NO_PRICE`, `PRD_NO_SELECTED_MODEL`, and `PLUGIN_AGENT_MISSING` to stay byte-identical under locale C and locale en_US.UTF-8. `GSD_RETIRED_RUNTIME` is required by AC-15 and uses the same ASCII pattern. It is not a sixth NFR.

NFR-S1 and NFR-C1 are non-negotiable. No measurement of a live secret scan was supplied, so `arch_nfr_budget` was not called. Absence of a measurement is not a pass. A10 runs the scan. A03 does not accept a match.

No GDPR, CCPA, HIPAA, PCI-DSS, or SOC2 regime was named. This table does not add one.
