# NFR bindings — Double Uplift (Tdde6-arch)

Correlation: `dde6accb-e288-424f-8913-cb429e5f88ef`. Source: `docs/requirements/nfr.md` NFR-23..NFR-27. Evidence: `arch_nfr_allocation` → `nfr_count: 5`, `allocated: [NFR-23..NFR-27]`, `unallocated: []`, `unmeasurable: []`, `coverage_pct: 100`, `fully_allocated: true`.

| NFR | Kind | Numeric limit | Contract clause / component budget | Verifier |
|---|---|---|---|---|
| NFR-23 | perf | second-uplift local processing ≤ 1000 ms for a 500-line XML, 0 retries after first failure | clause `ultrathink-double-uplift#/info/x-nfr-23-ms` | A08.unit |
| NFR-24 | security | 0 secrets sent, 100% matched secret patterns redacted, secret scan 0 findings | clause `ultrathink-double-uplift#/info/x-secret-scan-matches` | A08.security |
| NFR-25 | a11y | 0 color-only meanings, 100% of full-prompt section readable without a dialog | component budget `blueprint-Tdde6-arch.md#5` (plain text full-prompt-beneath) | A08.unit |
| NFR-26 | i18n | 0 locale-dependent formats, 100% of shipped strings en-US | clause `ultrathink-double-uplift#/info/x-locale` = en-US | A08.unit |
| NFR-27 | compliance | 0 new first-party dependencies, 100% of changed files AGPL | component budget `blueprint-Tdde6-arch.md#8` (supply chain) | A08.compliance |

No NFR is unallocated or unmeasurable. Unallocated NFRs would be escalated to A02, never silently dropped. No live measurements were supplied, so `arch_nfr_budget` was not called with live values — absence is not a pass.
