// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

/**
 * Process environment access for core. `read` returns the current environment; adapters back it with the real
 * process environment. Callers MUST NOT cache the result across reads when they need the live value.
 */
export interface EnvironmentPort {
	read(): Readonly<Record<string, string | undefined>>;
}
