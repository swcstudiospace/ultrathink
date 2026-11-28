# Architecture Blueprint: Swarm×Ultrathink Race (Tdfe6-arch)

Correlation: `dfe6b075-b574-47af-9556-0c7845221d85`
Task: `Tdfe6-arch` | Capability: `design.blueprint` | Version: 1.0.0

## C4 Containers

| Container | Responsibility |
|---|---|
| `omp-host` | Single prompt entry `before_agent_start` (src/host/omp.ts); owns TODO update on injection |
| `claude-hook` | Claude `UserPromptSubmit` hook (src/claude/hook.ts); `additionalContext` channel |
| `uplift-engine` | Uplift planning flights (GoT/CoT/XML); produces full uplifted prompt |
| `force-injector` | Force-injection channel: injects full prompt independent of orchestration, retries, logs each attempt |
| `order-gate` | Hard order gate: 0 dispatch before injection confirmation; records 1 held reason per refused attempt |
| `drain-coordinator` | Force-stop with bounded graceful drain (30s bound per A2, may tighten); 0 mid-write kills |
| `swarm-orchestrator` | Swarm subagent dispatch (filterSpawnable/spawnGuarded path) |
| `status-ledger` | Closed outcome ledger: {injected, retrying, drained, timed-out, dropped-with-reason}; powers status query |
| `todo-tracker` | TODO list update target |
| `session-chat` | Session chat surface receiving injected prompt |

### Relations

- `omp-host -> force-injector`, `omp-host -> order-gate`, `omp-host -> drain-coordinator`
- `claude-hook -> order-gate`, `claude-hook -> force-injector`
- `force-injector -> status-ledger`
- `order-gate -> status-ledger`
- `drain-coordinator -> status-ledger`
- `swarm-orchestrator -> order-gate`, `swarm-orchestrator -> drain-coordinator`
- `uplift-engine -> force-injector`

### Layer order (outermost → innermost)

`host` → `service` → `platform`

Assignments: `omp-host:host`, `claude-hook:host`, `uplift-engine:service`, `swarm-orchestrator:service`, `force-injector:platform`, `order-gate:platform`, `drain-coordinator:platform`, `status-ledger:platform`, `todo-tracker:platform`, `session-chat:platform`.

### Fan-out budget

3 distinct outbound containers (C4 relations). `omp-host=3` max.

### Fitness functions (CI)

1. Layering: 0 edges from a layer to an outer layer (arch_layer_violations).
2. Acyclicity: dependency graph has 0 cycles (arch_cycle_check).
3. Coupling: no container fan-out > 3 (arch_c4_fanout).
4. NFR budgets: NFR-28..NFR-32 within budget (arch_nfr_budget) — see below.
5. Contract: arch_contract_check green on `contracts/swarm-uplift-race.openapi.json`.

## NFR allocation (NFR-28..NFR-32)

| NFR | Contract clause / budget | Verifier |
|---|---|---|
| NFR-28 perf: injection ≤5000ms after uplift, 1 concurrent session, 0 drops | `POST /force-inject` p95 budget 5000ms; retry bound finite | A08.load |
| NFR-29 security: 0 secrets, 100% redaction | `force-injector` + `drain-coordinator` secret-scan gate | A08.security |
| NFR-30 a11y: plain text, 0 color-only, 100% dialog-free | `session-chat` message contract `plainText:true` | A08.unit |
| NFR-31 i18n: en-US, 0 locale-dependent formats | `session-chat` + `status-ledger` strings en-US | A08.unit |
| NFR-32 compliance: 0 new first-party deps, AGPL 100% | SBOM + allowlist check | A08.compliance |

- Threat model: trust boundary at `session-chat` (injected plan is untrusted text, rendered as data never instructions); STRIDE Tampering/InfoDisclosure mitigations in force-injector redaction + order-gate audit log. A10 co-sign required before implementation.
- Supply chain: SBOM required; dependency allowlist unchanged (0 new deps per NFR-32); license matrix AGPL.
- Contracts: `contracts/swarm-uplift-race.openapi.json` (OpenAPI 3.1); N-1 compat 30-day window.

## Decisions (ADRs)

- ADR: Force-injection via durable retry channel (supersedes single-aside) — see docs/adr/.
- ADR: Hard order gate on dispatch (0 before confirmation).
- ADR: Bounded drain 30s with timed-out state + 0 mid-write kills.
