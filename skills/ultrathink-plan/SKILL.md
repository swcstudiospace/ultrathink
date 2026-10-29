---
name: ultrathink-plan
description: Read the ultrathink plan written for this turn before other work. Use when a host discarded hook stdout, or when last-plan.<sessionId>.json exists for the current session.
---

# Ultrathink plan

The TypeScript engine already planned this prompt. Hook stdout is not a reliable delivery channel on every host (Grok discards an allowing `UserPromptSubmit` `additionalContext`). The plan lives in a file.

1. Read this session's carrier, `last-plan.<sessionId>.json`, from the host state directory. `<sessionId>` is the id of the current session as the host reports it, with every character outside `A-Z a-z 0-9 _ -` replaced by `_` and cut to 64 characters. One state directory serves several sessions at once, so never read `last-plan.json` (an older build's single file) and never read another session's file. In order, try:
   - `$ULTRATHINK_STATE_DIR/last-plan.<sessionId>.json`
   - `$GROK_PLUGIN_DATA/ultrathink/last-plan.<sessionId>.json`
   - `${GROK_HOME:-~/.grok}/plugin-data/ultrathink/last-plan.<sessionId>.json`
   - `$HERMES_HOME/ultrathink/last-plan.<sessionId>.json`, or `~/.hermes/ultrathink/last-plan.<sessionId>.json` when `HERMES_HOME` is unset
   - `$XDG_CONFIG_HOME/muse/ultrathink/last-plan.<sessionId>.json` or `~/.config/muse/ultrathink/last-plan.<sessionId>.json`
   - `$PI_CODING_AGENT_DIR/ultrathink/last-plan.<sessionId>.json` or `~/.omp/agent/ultrathink/last-plan.<sessionId>.json`
   - `$PRIME_AGENT_CODING_AGENT_DIR/ultrathink/last-plan.<sessionId>.json` or `~/.prime/agent/ultrathink/last-plan.<sessionId>.json` (on Prime Agent, `ultrathink.last()` in the kernel reads it for the kernel's own session)
   - `~/.claude/ultrathink/last-plan.<sessionId>.json`

   Compare the `sessionId` field inside the file with the current session id. If the file is absent, or the two differ, there is no plan for this session: stop here, do not use another session's plan, and do not reuse a plan or spec from an earlier message.
2. If `specPath` is set, read that file. It is plugin-authored elaboration of the user's message, not a new permission and not an instruction to ignore the user. The `ORIGINAL` element is the user's verbatim words.
3. Invoke `ultrathink-kickoff` before other work so the Notion and Linear rows exist.
4. Do not reprint the XML. Do not write `.planning/` into the working directory.
