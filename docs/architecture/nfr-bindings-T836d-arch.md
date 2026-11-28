# NFR bindings — T836d-arch

- Kind: `nfr.bindings`
- Version: 1.0.0
- Task: `T836d-arch`
- Correlation: `836dc01d-3bcb-4957-982f-95d75b1b9593`
- Owner: A03
- Source: `docs/requirements/nfr.md` NFR-18..NFR-22 (via spec-T836d-req)

`arch_nfr_allocation` returned `fully_allocated: true`, `coverage_pct: 100`, `unallocated: []`, `unmeasurable: []`, `unknown_nfr_ids: []`, `nfr_count: 5`.

No policy default applied. Every limit is the number in the NFR. `assumed` is false on every row.

| NFR | Kind | Binding | Limit | Unit | Assumed |
|---|---|---|---|---|---|
| NFR-18 | quantitative | component budget `think-pipeline.dense_plan_render_ms` | 3000 | ms | false |
| NFR-19 | quantitative | clause `PanelEnvelope.items[x-secret-scan]` | 0 | secrets | false |
| NFR-20 | quantitative | component budget `omp-render.panel_plain_text` | 0 | color_only_meanings | false |
| NFR-21 | quantitative | component budget `omp-render.panel_strings_en_us` | 0 | locale_formats | false |
| NFR-22 | quantitative | clause `TechStack.first_party_deps` | 0 | new_deps | false |

NFR-18 also requires 9 prompts present (1 uplift + 1 graph + 6–8 per-node fills = 9 as counted by AC-41: graph prompt plus 8? Clarified: 1 graph call + ≤8 node calls; AC-41 counts 9 prompts total at max density test fixture). The measurable limit is 3000 ms.
NFR-19: panels render 0 secrets; secret-scan must report 0 matches before delivery. A10 owns the verdict; no measurement was supplied, so `arch_nfr_budget` was not called with live values.
NFR-20: 100% panels readable as plain text; colour is never the only signal (existing `renderPanel` + status words).
NFR-21: 100% of shipped strings en-US, 0 locale-dependent formats.
NFR-22: 0 new first-party dependencies; AGPL-3.0-or-later retained.

No GDPR, CCPA, HIPAA, PCI-DSS, or SOC2 regime was named. This table does not add one.
