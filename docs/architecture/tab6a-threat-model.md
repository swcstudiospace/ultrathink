# Threat model — Tab6a

- Kind: `threat.model`
- Version: 1.0.0
- Task: `Tab6a-arch`
- Correlation: `ab6a76d6-3e64-4867-8476-b7acb5c4dee0`
- Owner: A03
- Co-sign: required from A10 before implementation tasks open
- `security.policy`: not attached. No regime was named. This model does not accept residual risk.

`arch_c4_fanout` with `fan_out_budget: 100` returned `container_count: 8`, `relation_count: 7`, `max_fan_out: 3`, `over_budget: []`, `isolated: []`. No container is isolated.
## Zones

| Zone | Containers | Trust |
|---|---|---|
| Operator | none of the eight modules | trusted to confirm Ship and to answer blocking clarifications |
| Plugin process | `omp-session-gate`, `phase-loop`, `plugin-inventory`, `tot-prd`, `model-router`, `uplift-completeness`, `sub-issue-store` | local, same user, untrusted model text passes through |
| Model provider | none; called by the existing session | untrusted output |
| Runtime host | the 18 CLI ids, each a separate host | a loaded entry is not a grant to skip Ship confirmation |
| Secret control | `secret-scan` (`src/redact.ts`) | control, not a trust zone. A10 owns the verdict |

## Crossings

### C1. Operator prompt to model provider and back into agent context

Ends: operator zone and model-provider zone, through `omp-session-gate` and `uplift-completeness`.

| STRIDE | Threat | Mitigation |
|---|---|---|
| Spoofing | A subagent or non-plannable prompt is treated as the primary wait. | Subagent sessions stay outside US-1. Non-plannable prompts wait 0 ms. |
| Tampering | A pending note or partial uplift starts work. | ADR-0001. First work turn requires one complete uplift. |
| Repudiation | A 5-10 minute stall is logged as a timeout failure. | Gate clock records progress. `UPLIFT_WAIT_EXCEEDED` is not a timeout-failure code. |
| Information disclosure | Secrets in the uplift XML reach the agent context. | `secret-scan` must report 0 matches before delivery. NFR-S1, NFR-C1. A10 co-signs. |
| Denial of service | The handler is blocked for 10 minutes and the host drops it. | Return before 30 s. Do not raise `raceMs`. |
| Elevation of privilege | The hold text authorizes tools. | Hold text does not authorize reads, edits, or commands. Tool calls stay blocked until the gate opens. |

High-risk: yes, because model output crosses into the operator's agent context. A10 co-sign required. A03 does not accept the residual disclosure risk.

### C2. Model output into the Code Blocked PRD and sub-issue store

Ends: model-provider zone and plugin process, through `tot-prd` and `sub-issue-store`.

| STRIDE | Threat | Mitigation |
|---|---|---|
| Spoofing | Tree-of-Thought records a model that was not the cheapest priced callable model. | Caller-supplied published prices. Tie break is model id order. No new price service. |
| Tampering | A PRD is attached before Chain-of-Thought is recorded or before Tree-of-Thought finishes. | PRD count stays 0 until Tree-of-Thought finishes. |
| Repudiation | The PRD omits the CoT step count. | Recorded CoT step count must equal the recorded steps. |
| Information disclosure | The PRD contains a secret-scan match. | 0 matches before attach. NFR-S1 and NFR-C1. Not waivable. |
| Denial of service | n/a | The PRD is one document per node. It does not add a network service. |
| Elevation of privilege | Model text in the PRD is treated as an instruction to skip the Ship gate. | PRD text is data. Ship still requires 1 operator confirmation. |

High-risk: yes, for information disclosure. A10 co-sign required. A03 does not accept a secret match.

### C3. Plugin inventory to a runtime host

Ends: plugin process and runtime-host zone, through `plugin-inventory`.

| STRIDE | Threat | Mitigation |
|---|---|---|
| Spoofing | `pi` is scored as `omp`, or `vscode` is required. | Ids stay distinct. `vscode` is excluded. `omp` is not in the 18. |
| Tampering | `gemini` is added to the required set. | `GSD_RETIRED_RUNTIME`. Set size stays 18. |
| Repudiation | A missing entry is reported connected. | Zero loaded entries yield `PLUGIN_AGENT_MISSING`. |
| Information disclosure | n/a for this crossing | The inventory line is `runtime=<id> status=connected` and does not carry credentials. |
| Denial of service | n/a | The inventory is a local read of entries. |
| Elevation of privilege | A connected runtime skips the operator confirmation. | US-4 Ship gate is separate. Connection is not confirmation. |

High-risk: no. A loaded entry is not a privilege grant. A10 still sees this row because the inventory decides which host may run the loop.

### C4. Phase loop to the operator

Ends: plugin process and operator zone, through `phase-loop`.

| STRIDE | Threat | Mitigation |
|---|---|---|
| Spoofing | An unanswered blocking clarification is treated as answered. | Execute start count stays 0 while any blocking clarification is unanswered. |
| Tampering | Ship starts with zero confirmations. | Ship start count stays 0 until 1 confirmation after Verify. |
| Repudiation | The phase order is rewritten. | Recorded order is Discuss, Plan, Execute, Verify, Ship. |
| Information disclosure | n/a | The confirmation is a boolean, not a secret. |
| Denial of service | n/a | The loop does not add a remote call. |
| Elevation of privilege | The plugin ships unattended. | Fully unattended Ship is out of scope. Assumption A-3. |

High-risk: no, provided the Ship gate is enforced. A10 confirms that enforcement. A03 does not waive it.

## Control mapping

No GDPR, CCPA, HIPAA, PCI-DSS, or SOC2 regime was named. `docs/ops/compliance-mapping.md` is an existing engineering mapping and is not an attestation for this change. It is not applied here as a regime.

The only named controls are NFR-S1 (A10.sast) and NFR-C1 (A10.secrets). Both require 0 secret-scan matches. The scanner is `src/redact.ts`. A03 does not accept residual risk and does not mark any threat accepted.

## Open questions for A10

- `security.policy` was not in the upstream artifacts. A10 should supply one if a regime applies. A03 will not invent one.
- A10 co-sign is required for crossings C1 and C2 before implementation tasks open.
