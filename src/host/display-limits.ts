/** First engine errors are persisted and shown to the agent: redacted, one line, bounded. */

export const MAX_ENGINE_ERROR_CHARS = 500;

/**
 * Ceiling for a handoff. Hermes spills a hook context piece over 10,000 characters to a file and keeps only its first
 * and last 500, which could hide the kickoff instruction in the middle.
 */
export const HANDOFF_MAX_CHARS = 9_000;
