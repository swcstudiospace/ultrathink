// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import type { ErrorCategory } from "./command.ts";

type LifecycleStage = "load" | "invoke" | "complete" | "error";

/**
 * Payload of every lifecycle event. It is closed: adapters MUST NOT add keys.
 * It never carries credentials, so no key named token, secret, or password may appear.
 */
export interface LifecyclePayload {
	readonly command: string;
	readonly correlationId: string;
	readonly errorCategory?: ErrorCategory;
}

export interface LifecycleEvent {
	readonly stage: LifecycleStage;
	readonly payload: LifecyclePayload;
}

export interface LifecycleEventPort {
	emit(event: LifecycleEvent): void;
}
