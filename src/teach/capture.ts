// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Captures, confirms and forgets Teachable Moments and keeps Hindsight in step with the local store. The local store is
 * the source of truth and always written first; Hindsight is the shared copy, so a down or unconfigured server only
 * delays the second write (the outbox) and never loses or blocks a lesson. Everything is redacted before it is hashed,
 * stored or sent. Nothing here throws except `TeachInputError` for input a caller can fix.
 */
import { randomUUID } from "node:crypto";
import type {
	HindsightClient,
	HindsightErrorKind,
	HindsightResult,
	RetainOutcome,
} from "../hindsight/types.ts";
import { collapseWhitespace, nowOf, unique } from "../shared.ts";
import { hindsightFor, teachEnabled, tryStore } from "./context.ts";
import {
	contentFor,
	dedupeKeyFor,
	documentIdFor,
	gitRootsOf,
	metadataFor,
	projectOf,
	tagsFor,
} from "./mapping.ts";
import { redactLine, redactText, type RedactOptions } from "./redact.ts";
import { AUTO_PROMOTE_WINDOW_MS, normalizeSignature } from "./skill-author.ts";
import { isValidId } from "./store.ts";
import {
	MAX_BODY_CHARS,
	MAX_DESCRIPTION_CHARS,
	MAX_NAME_CHARS,
	MOMENT_KINDS,
	MOMENT_ORIGINS,
	type CaptureFn,
	type CaptureInput,
	type CaptureOutcome,
	type MomentStatus,
	type OutboxEntry,
	type SyncOutcome,
	type TeachableMoment,
	type TeachContext,
	type TeachStore,
} from "./types.ts";

/** Invalid input (empty name or body, unknown kind): the caller can fix it, so it is the one error capture throws. */
export class TeachInputError extends Error {}

/** Entries one `syncOutbox` call may attempt: a hook must not spend its time budget on a long backlog. */
const SYNC_BATCH = 20;
const MAX_LIST_ITEMS = 20;
const MAX_TAGS = 40;
const RETAIN_CONTEXT = "ultrathink teachable moment";
/** Status only moves up: a repeat capture can confirm a candidate, never demote a confirmed lesson. */
const STATUS_RANK: Record<MomentStatus, number> = {
	candidate: 0,
	confirmed: 1,
	promoted: 2,
	superseded: 3,
};

type Failure = { ok: false; kind?: HindsightErrorKind; message: string };
type Step = { ok: true } | Failure;

/** True when Hindsight holds an up-to-date copy: a repeat capture bumps `lastSeenAt` past `retained.at`. */
function isRetained(moment: TeachableMoment): boolean {
	if (!moment.retained) return false;
	return !(Date.parse(moment.retained.at) < Date.parse(moment.lastSeenAt));
}

/**
 * The moment a capture stands for. `strict` validates (throws `TeachInputError`); the lenient form only normalizes,
 * for the "off" outcome, which carries a moment the caller can still show but that is never stored.
 */
function buildMoment(
	input: CaptureInput,
	ctx: TeachContext,
	now: number,
	strict: boolean,
): TeachableMoment {
	const rawName = typeof input.name === "string" ? input.name : "";
	const rawBody = typeof input.body === "string" ? input.body : "";
	if (strict) {
		if (rawName.trim() === "") throw new TeachInputError("name is required");
		if (rawBody.trim() === "") throw new TeachInputError("body is required");
		if (input.kind !== undefined && !MOMENT_KINDS.includes(input.kind))
			throw new TeachInputError(`kind must be one of: ${MOMENT_KINDS.join(", ")}`);
		if (input.origin !== undefined && !MOMENT_ORIGINS.includes(input.origin))
			throw new TeachInputError(`origin must be one of: ${MOMENT_ORIGINS.join(", ")}`);
		if (input.status !== undefined && input.status !== "candidate" && input.status !== "confirmed")
			throw new TeachInputError("status must be candidate or confirmed");
		if (input.confidence !== undefined && !Number.isFinite(input.confidence))
			throw new TeachInputError("confidence must be a number");
		if (input.supersedes !== undefined && !isValidId(input.supersedes))
			throw new TeachInputError("supersedes must be a moment id");
	}
	const kind = input.kind && MOMENT_KINDS.includes(input.kind) ? input.kind : "pitfall";
	const origin = input.origin && MOMENT_ORIGINS.includes(input.origin) ? input.origin : "explicit";
	const status: MomentStatus =
		input.status === "candidate" || input.status === "confirmed"
			? input.status
			: origin === "observe"
				? "candidate"
				: "confirmed";
	const confidence = Math.min(
		1,
		Math.max(
			0,
			Number.isFinite(input.confidence)
				? (input.confidence as number)
				: origin === "observe"
					? 0.5
					: 1,
		),
	);

	const home = ctx.env.HOME ?? process.env.HOME;
	const redact: RedactOptions = { home, repoRoot: gitRootsOf(ctx.cwd)?.worktree ?? ctx.cwd };
	const list = (items: readonly unknown[] | undefined, max: number): string[] =>
		unique(
			(Array.isArray(items) ? items : [])
				.flatMap((item) =>
					typeof item === "string"
						? [collapseWhitespace(redactText(item, redact)).slice(0, max).trimEnd()]
						: [],
				)
				.filter(Boolean),
			{ max: MAX_LIST_ITEMS },
		);

	const name = collapseWhitespace(redactText(rawName, redact)).slice(0, MAX_NAME_CHARS).trimEnd();
	const project = projectOf(ctx.cwd);
	const iso = new Date(now).toISOString();
	const moment: TeachableMoment = {
		id: randomUUID(),
		name,
		description: collapseWhitespace(
			redactText(typeof input.description === "string" ? input.description : "", redact),
		)
			.slice(0, MAX_DESCRIPTION_CHARS)
			.trimEnd(),
		body: redactText(rawBody, redact)
			.replace(/\r\n?/g, "\n")
			.trim()
			.slice(0, MAX_BODY_CHARS)
			.trimEnd(),
		sourcePhase: collapseWhitespace(
			redactText(typeof input.sourcePhase === "string" ? input.sourcePhase : "", redact),
		)
			.slice(0, 120)
			.trimEnd(),
		sourceArtifacts: list(input.sourceArtifacts, 300),
		createdAt: iso,
		tags: list(input.tags, 80).slice(0, MAX_TAGS),
		relatedIds: unique(
			(Array.isArray(input.relatedIds) ? input.relatedIds : []).filter(isValidId),
			{ max: MAX_LIST_ITEMS },
		),
		schema: 2,
		kind,
		status,
		origin,
		project,
		host: ctx.host,
		confidence,
		occurrences: 1,
		lastSeenAt: iso,
		dedupeKey: dedupeKeyFor(project, kind, name),
		recalled: 0,
	};
	if (input.supersedes !== undefined && isValidId(input.supersedes))
		moment.supersedes = input.supersedes;
	return moment;
}

/** `fresh` is a repeat of `old`: count it, refresh it, keep the better text, never lower the status. */
function mergeMoments(old: TeachableMoment, fresh: TeachableMoment): TeachableMoment {
	const better = fresh.confidence >= old.confidence;
	const status =
		old.status === "superseded" || STATUS_RANK[fresh.status] <= STATUS_RANK[old.status]
			? old.status
			: fresh.status;
	const merged: TeachableMoment = {
		...old,
		body: better ? fresh.body : old.body,
		description: better && fresh.description !== "" ? fresh.description : old.description,
		sourcePhase: old.sourcePhase || fresh.sourcePhase,
		sourceArtifacts: unique([...old.sourceArtifacts, ...fresh.sourceArtifacts], {
			max: MAX_LIST_ITEMS,
		}),
		tags: unique([...old.tags, ...fresh.tags], { max: MAX_TAGS }),
		relatedIds: unique([...old.relatedIds, ...fresh.relatedIds], { max: MAX_LIST_ITEMS }),
		status,
		confidence: Math.max(old.confidence, fresh.confidence),
		occurrences: old.occurrences + 1,
		lastSeenAt: fresh.lastSeenAt,
	};
	const supersedes = fresh.supersedes ?? old.supersedes;
	if (supersedes !== undefined) merged.supersedes = supersedes;
	return merged;
}

/**
 * A capture inside the 14 days after a resolution is that resolution's recurrence, whichever lesson it lands on. Only the
 * first such capture is kept. `captured` is already stored, so the scan judges it as it now reads.
 */
function recordRecurrence(store: TeachStore, captured: TeachableMoment): void {
	const signature = normalizeSignature(captured.name);
	const capturedAt = Date.parse(captured.lastSeenAt);
	for (const other of store.list()) {
		if (other.resolvedAt === undefined || other.recurredAt !== undefined) continue;
		const resolvedAt = Date.parse(other.resolvedAt);
		const inWindow = capturedAt > resolvedAt && capturedAt <= resolvedAt + AUTO_PROMOTE_WINDOW_MS;
		if (inWindow && normalizeSignature(other.name) === signature) {
			store.put({ ...other, recurredAt: captured.lastSeenAt });
		}
	}
}

function dropRetainOps(store: TeachStore, momentId: string): void {
	for (const entry of store.outbox()) {
		if (entry.op.op === "retain" && entry.op.momentId === momentId) store.ack(entry.id);
	}
}

/** One retain of one moment; on success the moment records `retained` and its pending retain ops are dropped. Success means
 *  the stored lesson still is the text the request carried; a concurrent capture leaves the newer text queued instead. */
async function retainOne(
	moment: TeachableMoment,
	client: HindsightClient,
	store: TeachStore,
	ctx: TeachContext,
): Promise<Failure | { ok: true; moment: TeachableMoment } | { ok: true; forgotten: true }> {
	const documentId = documentIdFor(moment.id);
	const sentContent = contentFor(moment);
	let result: HindsightResult<RetainOutcome>;
	try {
		result = await client.retain({
			documentId,
			content: sentContent,
			context: RETAIN_CONTEXT,
			tags: tagsFor(moment),
			metadata: metadataFor(moment),
			timestamp: moment.createdAt,
		});
	} catch (error) {
		return {
			ok: false,
			message: `retain failed: ${redactLine(error instanceof Error ? error.message : String(error))}`,
		};
	}
	if (!result.ok)
		return {
			ok: false,
			kind: result.error.kind,
			message: `retain failed (${result.error.kind}): ${redactLine(result.error.message)}`,
		};
	// The remote write already happened and cannot be unsent; a cancelled lifetime still gets no
	// local put, acknowledgment or success claim from this completion.
	if (ctx.signal?.aborted)
		return {
			ok: false,
			message: "retain cancelled after dispatch; the local copy was left unchanged",
		};
	// Reread before spreading retention metadata so a deferred completion cannot overwrite newer
	// lesson state (a worker confirm, a merged capture) with the stale pre-await object.
	const current = store.get(moment.id);
	if (!current) {
		// `get` is undefined for a removed lesson and for one that cannot be read: only a confirmed removal may delete the
		// remote copy, because a damaged local file may be the last good copy.
		if (store.has(moment.id))
			return {
				ok: false,
				message:
					"the local lesson is unreadable; the remote copy was kept and the lesson stays queued to sync",
			};
		// The lesson was forgotten while the request was in flight. The remote document the request created cannot be
		// unsent, so delete it (or queue the delete) and write nothing locally.
		let deleted = false;
		try {
			deleted = (await client.deleteDocument(documentId)).ok;
		} catch {
			// reason: a failed delete is queued below
		}
		try {
			dropRetainOps(store, moment.id);
		} catch {
			// reason: a leftover retain entry for a forgotten lesson is acknowledged by the next sync
		}
		if (deleted) return { ok: true, forgotten: true };
		try {
			store.enqueue({ op: "delete", documentId }, nowOf(ctx));
		} catch {
			// reason: the remote delete failed and could not be queued, so a remote copy may remain with no retry
			return {
				ok: false,
				message:
					"the lesson was forgotten while it was being retained; its remote delete failed and could not be queued, so a remote copy may remain",
			};
		}
		return { ok: true, forgotten: true };
	}
	// Acknowledge only the revision the request carried: if a capture changed the lesson while this
	// retain was pending, the remote holds the older text, so the newer text must stay unretained —
	// with any queued retry intact — and reach Hindsight on a later sync.
	if (contentFor(current) !== sentContent) {
		return {
			ok: false,
			message: "retain succeeded for an older revision; the newer lesson text stays queued to sync",
		};
	}
	const retained: TeachableMoment = {
		...current,
		retained: { at: new Date(nowOf(ctx)).toISOString(), bank: client.bank, documentId },
	};
	try {
		store.put(retained);
		dropRetainOps(store, moment.id);
	} catch {
		// reason: Hindsight has it; the next sync re-retains the same document id, which is idempotent.
	}
	return { ok: true, moment: retained };
}

/** Retains a confirmed or promoted moment (`force` skips the "already up to date" check); candidates and superseded moments stay local. */
async function settle(
	moment: TeachableMoment,
	ctx: TeachContext,
	store: TeachStore,
	force: boolean,
): Promise<Pick<CaptureOutcome, "moment" | "retain" | "reason">> {
	if (moment.status === "candidate")
		return { moment, retain: "local-only", reason: "candidate: local only until confirmed" };
	if (moment.status === "superseded")
		return { moment, retain: "local-only", reason: "superseded: not retained" };
	if (!force && isRetained(moment)) return { moment, retain: "retained" };
	const { client, reason } = hindsightFor(ctx);
	if (!client) return { moment, retain: "local-only", reason };
	const result = await retainOne(moment, client, store, ctx);
	if (result.ok && "forgotten" in result)
		return {
			moment,
			retain: "off",
			reason: "the lesson was forgotten while it was being retained; nothing was kept",
		};
	if (result.ok) return { moment: result.moment, retain: "retained" };
	// A cancelled lifetime never turns a failed retain into a queued outbox write.
	if (ctx.signal?.aborted)
		return {
			moment,
			retain: "local-only",
			reason:
				"action cancelled before the failed retain could be queued; the local lesson is unchanged",
		};
	try {
		store.enqueue({ op: "retain", momentId: moment.id }, nowOf(ctx));
	} catch {
		// reason: the moment is stored; syncOutbox backfills unretained confirmed moments anyway
	}
	return { moment, retain: "queued", reason: result.message };
}

/** Marks `oldId` superseded and, when Hindsight holds it, queues the tag change that hides it from recall. */
function supersede(
	store: TeachStore,
	oldId: string,
	newId: string,
	now: number,
): OutboxEntry | undefined {
	const old = store.get(oldId);
	if (!old || old.id === newId || old.status === "superseded") return undefined;
	const updated: TeachableMoment = { ...old, status: "superseded" };
	store.put(updated);
	dropRetainOps(store, old.id);
	if (!old.retained) return undefined;
	return store.enqueue(
		{ op: "tags", documentId: documentIdFor(old.id), tags: tagsFor(updated) },
		now,
	);
}

async function runOp(
	op: OutboxEntry["op"],
	client: HindsightClient,
	store: TeachStore,
	ctx: TeachContext,
): Promise<Step> {
	try {
		if (op.op === "retain") {
			const moment = store.get(op.momentId);
			// Gone, demoted or already up to date: nothing to do, and the entry is done.
			if (
				!moment ||
				(moment.status !== "confirmed" && moment.status !== "promoted") ||
				isRetained(moment)
			)
				return { ok: true };
			const result = await retainOne(moment, client, store, ctx);
			return result.ok ? { ok: true } : result;
		}
		const result =
			op.op === "delete"
				? await client.deleteDocument(op.documentId)
				: await client.setDocumentTags(op.documentId, op.tags);
		if (result.ok) return { ok: true };
		// A tag change for a document that is gone has nothing left to do.
		if (op.op === "tags" && result.error.kind === "not-found") return { ok: true };
		return {
			ok: false,
			kind: result.error.kind,
			message: `${op.op} failed (${result.error.kind}): ${redactLine(result.error.message)}`,
		};
	} catch (error) {
		return {
			ok: false,
			message: `${op.op} failed: ${redactLine(error instanceof Error ? error.message : String(error))}`,
		};
	}
}

async function persist(
	moment: TeachableMoment,
	store: TeachStore,
	ctx: TeachContext,
	now: number,
): Promise<CaptureOutcome> {
	const existing = store.findByDedupeKey(moment.dedupeKey);
	// A superseded lesson captured again is a new lesson, not a repeat of the replaced one.
	const target = existing && existing.status !== "superseded" ? existing : undefined;
	const saved = target ? mergeMoments(target, moment) : moment;
	store.put(saved);
	try {
		recordRecurrence(store, saved);
	} catch {
		// reason: the capture is stored; an unrecorded recurrence leaves its resolution credited, so it is logged
		ctx.log?.("teach: a recurrence could not be recorded; a resolution may count in error");
	}
	const tagsEntry = moment.supersedes
		? supersede(store, moment.supersedes, saved.id, now)
		: undefined;
	const settled = await settle(saved, ctx, store, true);
	if (tagsEntry) {
		const { client } = hindsightFor(ctx);
		if (client && (await runOp(tagsEntry.op, client, store, ctx)).ok) store.ack(tagsEntry.id);
	}
	return { ...settled, created: target === undefined };
}

export const captureMoment: CaptureFn = async (input, ctx) => {
	const now = nowOf(ctx);
	if (!teachEnabled(ctx))
		return {
			moment: buildMoment(input, ctx, now, false),
			created: false,
			retain: "off",
			reason: "teach is off",
		};
	const moment = buildMoment(input, ctx, now, true);
	const store = tryStore(ctx);
	if (!store)
		return { moment, created: false, retain: "off", reason: "teach store is unavailable" };
	try {
		return await persist(moment, store, ctx, now);
	} catch (error) {
		return {
			moment,
			created: false,
			retain: "off",
			reason: `teach store write failed: ${redactLine(error instanceof Error ? error.message : String(error))}`,
		};
	}
};

/** candidate -> confirmed, then retained like any confirmed moment; other statuses are unchanged. undefined for an unknown id. */
export async function confirmMoment(
	id: string,
	ctx: TeachContext,
): Promise<CaptureOutcome | undefined> {
	const store = tryStore(ctx);
	const moment = store?.get(id);
	if (!store || !moment) return undefined;
	if (!teachEnabled(ctx)) return { moment, created: false, retain: "off", reason: "teach is off" };
	try {
		const confirmed: TeachableMoment =
			moment.status === "candidate" ? { ...moment, status: "confirmed" } : moment;
		if (confirmed !== moment) {
			// Cancellation before dispatch mutates nothing: no local confirmation commit.
			if (ctx.signal?.aborted)
				return {
					moment,
					created: false,
					retain: "off",
					reason: "confirmation cancelled before it was stored",
				};
			store.put(confirmed);
		}
		return { ...(await settle(confirmed, ctx, store, false)), created: false };
	} catch (error) {
		return {
			moment,
			created: false,
			retain: "off",
			reason: `teach store write failed: ${redactLine(error instanceof Error ? error.message : String(error))}`,
		};
	}
}

/**
 * Records now as the moment the problem a lesson describes was fixed. A lesson keeps only its latest resolution, and a new
 * one clears any recurrence recorded against the earlier one. `rootCause`, when given, is stored with it; a resolution
 * without one clears the earlier root cause. Local only: nothing is retained or sent. undefined for an unknown lesson,
 * when Teachable Moments is off, or when the store cannot be written.
 */
export function resolveMoment(
	id: string,
	ctx: TeachContext,
	rootCause?: string,
): TeachableMoment | undefined {
	const store = tryStore(ctx);
	const moment = store?.get(id);
	if (!store || !moment || !teachEnabled(ctx)) return undefined;
	const resolved: TeachableMoment = {
		...moment,
		resolvedAt: new Date(nowOf(ctx)).toISOString(),
		recurredAt: undefined,
		rootCause,
	};
	try {
		store.put(resolved);
	} catch {
		// reason: a failed write leaves the lesson as it was; the caller gets undefined, never a partial record
		return undefined;
	}
	return resolved;
}

/** Removes the local file; a moment that reached (or may have reached) Hindsight also loses its document, now or from the outbox. */
export async function forgetMoment(
	id: string,
	ctx: TeachContext,
): Promise<{ removed: boolean; remote: "deleted" | "queued" | "retained" | "none" }> {
	const store = tryStore(ctx);
	const moment = store?.get(id);
	if (!store || !moment) return { removed: false, remote: "none" };
	// Hoisted so the catch can tell a possibly remote copy apart from a purely local lesson.
	let mayHaveRemote = Boolean(moment.retained);
	try {
		const inOutbox = store
			.outbox()
			.some((entry) => entry.op.op === "retain" && entry.op.momentId === id);
		mayHaveRemote ||= inOutbox;
		dropRetainOps(store, id);
		const removed = store.remove(id);
		if (!mayHaveRemote) return { removed, remote: "none" };
		const documentId = documentIdFor(id);
		const client = teachEnabled(ctx) ? hindsightFor(ctx).client : undefined;
		if (client) {
			const op: OutboxEntry["op"] = { op: "delete", documentId };
			if ((await runOp(op, client, store, ctx)).ok) return { removed, remote: "deleted" };
		}
		try {
			store.enqueue({ op: "delete", documentId }, nowOf(ctx));
		} catch {
			// reason: the delete was not made and could not be queued, so the remote copy may remain
			return { removed, remote: "retained" };
		}
		return { removed, remote: "queued" };
	} catch {
		// reason: a failure during the local removal may still leave a remote copy, so it is never "none" here.
		return {
			removed: store.get(id) === undefined,
			remote: mayHaveRemote ? "retained" : "none",
		};
	}
}

/** Replays due outbox entries (at most 20 per call), then retains confirmed moments that never reached Hindsight. */
export async function syncOutbox(ctx: TeachContext): Promise<SyncOutcome> {
	try {
		const store = tryStore(ctx);
		if (!store) return { done: 0, pending: 0, reason: "teach store is unavailable" };
		const entries = store.outbox();
		if (!teachEnabled(ctx)) return { done: 0, pending: entries.length, reason: "teach is off" };
		const { client, reason: unready } = hindsightFor(ctx);
		if (!client) return { done: 0, pending: entries.length, reason: unready };

		let done = 0;
		let reason: string | undefined;
		let stopped = false;
		const due = entries.filter((entry) => entry.nextAt <= nowOf(ctx)).slice(0, SYNC_BATCH);
		for (const entry of due) {
			if (ctx.signal?.aborted) {
				stopped = true;
				break;
			}
			const step = await runOp(entry.op, client, store, ctx);
			if (step.ok) {
				store.ack(entry.id);
				done++;
				continue;
			}
			store.fail(entry.id, step.message, nowOf(ctx));
			reason ??= step.message;
			if (step.kind === "auth") {
				stopped = true;
				break;
			}
		}

		const budget = SYNC_BATCH - due.length;
		if (!stopped && budget > 0) {
			const queued = new Set(
				store.outbox().flatMap((entry) => (entry.op.op === "retain" ? [entry.op.momentId] : [])),
			);
			const backlog = store
				.list()
				.filter(
					(moment) =>
						(moment.status === "confirmed" || moment.status === "promoted") &&
						!isRetained(moment) &&
						!queued.has(moment.id),
				)
				.slice(0, budget);
			for (const moment of backlog) {
				if (ctx.signal?.aborted) break;
				const step = await retainOne(moment, client, store, ctx);
				if (step.ok) {
					// A forgotten lesson was handled (remote delete issued or queued) and is not a delivered retain.
					if (!("forgotten" in step)) done++;
					continue;
				}
				// Queue it so the backoff applies instead of retrying on every sync.
				const entry = store.enqueue({ op: "retain", momentId: moment.id }, nowOf(ctx));
				store.fail(entry.id, step.message, nowOf(ctx));
				reason ??= step.message;
				if (step.kind === "auth") break;
			}
		}
		return reason
			? { done, pending: store.outbox().length, reason }
			: { done, pending: store.outbox().length };
	} catch (error) {
		return {
			done: 0,
			pending: 0,
			reason: redactLine(error instanceof Error ? error.message : String(error)),
		};
	}
}
