# Plugin milestone decisions

Recorded decisions for the six-host plugin work, so the evidence does not depend on gitignored planning files.

- Scope intent (plan Q1): "ultrathink workflowz" means this build's gsd-autonomous orchestration. Chosen by the operator for the plugin portability work.
- Omp behavior (plan Q2): frozen. Golden fixtures in test/golden/omp must show zero diff.
- Quality scope (plan Q3): plugin-touched modules only.
- CI access (plan Q4): Omp in CI; other hosts through the manual runbook in docs/validation/manual-matrix.md.
- Hosts (plan D3): no host blocked. Prime-Agent is skills-only and runs through its SKILL.md entry.
- Adapters: thin modules per host that wrap the existing bin/ultrathink entry point through an injected runner.
- Capability flags: declared to match the code (see conformance/hermes-subject.ts and conformance/prime-agent-subject.ts).
