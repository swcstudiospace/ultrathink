# Cleaned brief — Tab6a-req

Correlation: `ab6a76d6-3e64-4867-8476-b7acb5c4dee0`
Task: `Tab6a-req`
Capability: `req.spec`
PII scan: `req_pii_scan` found none (`has_pii: false`, `regimes_hint: []`).
Ambiguity scan of the redacted brief: score `0`, `needs_clarification: false`, terms `[]`.

The text below is the redacted copy. It matches the assignment brief because the scan found no email, phone, SSN, card, or IPv4 pattern.

## Redacted brief

Fix the Omp session start so it waits for the full XML-tagged uplifted prompt before beginning (5-10 min stall is intended). Upgrade Sub Issue module to generate Code Blocked PRDs via Tree-of-Thought after Chain of Thought, using the cheapest available model for ToT while selected model for GoT/CoT. Complete the plugin connection mechanism for all CLI Agents supported by GSD-Core by reviewing GSD-Core on web and GitHub and implementing the plugin. This is for the Ultrathink plugin which enables Semi-Autonomous SDDLC with GSD-Core.

## Assignment acceptance (quoted)

1. Omp session start waits for the full XML-tagged uplifted prompt before beginning; a 5-10 minute stall is intended and must not be treated as a timeout failure.
2. Sub Issue module generates Code Blocked PRDs via Tree-of-Thought after Chain of Thought, using the cheapest available model for ToT and the selected model for GoT and CoT.
3. Plugin connection mechanism is complete for every CLI agent supported by GSD-Core, based on GSD-Core web and GitHub evidence, and the Ultrathink plugin enables Semi-Autonomous SDDLC with GSD-Core.

## Stakeholders (quoted from the brief)

- The operator of the Ultrathink plugin on Omp, who starts a session and must receive the full uplifted prompt before work begins.
- The planner who owns the Sub-Issue module and the Code Blocked PRD output.
- The operator who connects the Ultrathink plugin to CLI agents supported by GSD-Core.

## Constraints (quoted)

- A stall of 5 to 10 minutes at Omp session start is intended.
- That stall must not be treated as a timeout failure.
- Tree-of-Thought runs after Chain of Thought.
- Tree-of-Thought uses the cheapest available model.
- Graph-of-Thought and Chain of Thought use the selected model.
- The plugin connection set is every CLI agent supported by GSD-Core, evidenced from GSD-Core on the web and on GitHub.
- The plugin enables Semi-Autonomous SDDLC with GSD-Core.
- This task defines what and how well. It does not implement the plugin.

## Success measures (quoted, then made numeric in the spec)

- Session start waits for the full XML-tagged uplifted prompt.
- A 5-10 minute stall is not a timeout failure.
- Sub-Issue output is a Code Blocked PRD from Tree-of-Thought after Chain of Thought, with the model split above.
- Connection is complete for every GSD-Core CLI agent, and semi-autonomous SDDLC is enabled.
