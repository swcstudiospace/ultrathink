// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createAuth } from "../auth/auth.ts";
import { type UltrathinkConfig, loadConfig } from "../config/config.ts";
import { createPlanBackend } from "../engine/plan.ts";
import { createLogger } from "../obs/log.ts";
import { createApp } from "../routes/router.ts";
import { openStore } from "../store/store.ts";
import { createFaultyClaude } from "./faults.ts";
import type { ChaosResponse, ChaosTarget } from "./observe.ts";
import type { ExperimentTemplate } from "./schema.ts";

// Public origin the requests are addressed to. The app never listens; requests go straight to `app.handle`.
const ORIGIN = "https://ultrathink.test";
// Every in-process request arrives from loopback, so /metrics (loopback only) answers.
const PEER_IP = "127.0.0.1";
// The stand-in upstream: a passing call runs this script in place of `claude`, and it fails as an upstream error.
const NO_UPSTREAM_MESSAGE = "no upstream in process";
// A real Claude model id; the stand-in never runs it, but the config validates its shape.
const PLANNING_MODEL = "claude-haiku-5-5";
// Fixed child PATH so the fault shims find `sleep` without reading process.env.
const CHILD_PATH = "/usr/local/bin:/usr/bin:/bin";

export interface InProcessTargetOptions {
	template: ExperimentTemplate;
	/** Absolute directory for the store and audit files. Created by the caller; never the production state directory. */
	stateDir: string;
	now?: () => Date;
}

export interface InProcessTarget {
	target: ChaosTarget;
	/** Idempotent. Closes the store; removes nothing from disk. */
	close(): Promise<void>;
}

/**
 * Builds the real app in process with a temporary state directory, the real plan backend (the production `claude`
 * completer with its own timer) whose child is the template's fault plan or, past the plan, a stand-in that fails, and
 * the template's config overrides. The environment is fixed and never read from process.env, so a run cannot pick up
 * production configuration. The app's own sleep is not overridden: the planner uses it for the whole-plan timer, and a
 * zero-delay sleep would time every plan out before its first upstream call. A blackhole or a latency past
 * `timeoutMs` ends by the backend's real kill, which is the behaviour under test.
 */
export async function createInProcessTarget(
	options: InProcessTargetOptions,
): Promise<InProcessTarget> {
	const { template, stateDir, now } = options;
	if (template.kind !== "inprocess" || template.plan === undefined) {
		throw new TypeError(`template ${template.id} is not an inprocess template with a fault plan`);
	}

	const connectorKey = randomBytes(32).toString("base64url");
	const ownerPasswordHash = await Bun.password.hash(randomBytes(24).toString("base64url"));
	const config = applyOverrides(
		loadConfig({
			ULTRATHINK_PUBLIC_ORIGIN: ORIGIN,
			ULTRATHINK_OWNER_PASSWORD_HASH: ownerPasswordHash,
			ULTRATHINK_SESSION_SECRET: randomBytes(32).toString("hex"),
			ULTRATHINK_STATE_DIR: stateDir,
			ULTRATHINK_PLAINTEXT_LOOPBACK: "1",
			ULTRATHINK_SERVER_PLANNING: "1",
			ULTRATHINK_PLANNING_MODEL: PLANNING_MODEL,
			ULTRATHINK_CONNECTOR_KEY: connectorKey,
		}),
		template.config,
	);

	const auth = createAuth({
		ownerPasswordHash: config.ownerPasswordHash,
		sessionSecret: config.sessionSecret,
		previousSessionSecrets: config.sessionSecretPrevious,
		cookieSecure: true,
	});
	const store = openStore(config.dbPath);
	const shimDir = join(stateDir, "chaos-shims");
	mkdirSync(shimDir, { recursive: true, mode: 0o700 });
	const noUpstream = join(shimDir, "no-upstream.sh");
	writeFileSync(noUpstream, `#!/bin/sh\necho "${NO_UPSTREAM_MESSAGE}" >&2\nexit 1\n`, {
		mode: 0o700,
	});
	const planBackend = createPlanBackend({
		model: PLANNING_MODEL,
		fallback: "none",
		concurrency: config.planConcurrency ?? 2,
		timeoutMs: config.modelTimeoutMs,
		env: { PATH: CHILD_PATH },
		// The stand-in stands for the `claude` binary, so readiness holds without one installed.
		which: () => noUpstream,
		claude: createFaultyClaude(template.plan, { dir: shimDir, bin: noUpstream }),
	});
	const app = createApp({
		config,
		store,
		auth,
		logger: createLogger({ write: () => undefined }),
		planBackend,
		...(now === undefined ? {} : { now: () => now().getTime() }),
	});

	let closing: Promise<void> | undefined;
	const close = (): Promise<void> => {
		closing ??= (async () => {
			await app.shutdown();
			store.close();
		})();
		return closing;
	};

	const target: ChaosTarget = {
		async request(method, path, body): Promise<ChaosResponse> {
			const headers: Record<string, string> = { "x-connector-key": connectorKey };
			const init: RequestInit = { method, headers };
			if (body !== undefined) {
				headers["content-type"] = "application/json";
				init.body = JSON.stringify(body);
			}
			const response = await app.handle(new Request(`${ORIGIN}${path}`, init), PEER_IP);
			return { status: response.status, headers: response.headers, text: await response.text() };
		},
		close,
	};

	return { target, close };
}

function applyOverrides(
	base: UltrathinkConfig,
	overrides: ExperimentTemplate["config"],
): UltrathinkConfig {
	if (overrides === undefined) return base;
	return {
		...base,
		breakerFailures: overrides.breakerFailures ?? base.breakerFailures,
		breakerOpenMs: overrides.breakerOpenMs ?? base.breakerOpenMs,
		maxInflight: overrides.maxInflight ?? base.maxInflight,
		modelTimeoutMs: overrides.timeoutMs ?? base.modelTimeoutMs,
	};
}
