-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Task Tdfe6-data / correlation dfe6b075-b574-47af-9556-0c7845221d85
-- Forward (expand): UpliftDeliveryRecord ledger for the Swarm x Ultrathink
-- race fix (Tdfe6): force-injection retries, order-gate holds and bounded
-- drains share one status-ledger row shape (FR-1..FR-4, closed state set).
-- Prepared only; execution is via A11 ephemeral/provisioned databases, never
-- by this agent. No existing table is touched (additive, no lock on
-- populated tables). Runtime source of truth remains the session files
-- plus the JSON contract contracts/swarm-uplift-race.data.json; this
-- table provisions the same ledger in shadow/future persistent stores.
-- Version id 2026112303 (next after 2026112302): data_migration_check
-- versions by the first numeric segment, so 2026112303 sorts after both
-- 2026.11.23-01 and 2026112302.
-- Rollback: 2026112303_uplift_delivery_records.down.sql
SET lock_timeout = '5s';

CREATE TABLE uplift_delivery_records (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id            text NOT NULL DEFAULT '',
    task_id               text,
    correlation_id        text NOT NULL DEFAULT '',
    record_type           text NOT NULL DEFAULT 'force_inject'
                          CHECK (record_type IN ('force_inject', 'order_gate', 'drain')),
    state                 text NOT NULL DEFAULT 'retrying'
                          CHECK (state IN ('injected', 'retrying', 'drained', 'timed-out', 'dropped-with-reason')),
    allowed               boolean NOT NULL DEFAULT false,
    held_reason           text NOT NULL DEFAULT '',
    prompt_text           text NOT NULL DEFAULT '',
    prompt_hash           text NOT NULL DEFAULT '',
    attempt_count         integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    retry_count           integer NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
    retry_budget          integer NOT NULL DEFAULT 3 CHECK (retry_budget >= 0),
    injection_latency_ms  integer NOT NULL DEFAULT 0
                          CHECK (injection_latency_ms >= 0 AND (state <> 'injected' OR injection_latency_ms <= 5000)),
    drain_bound_s         integer NOT NULL DEFAULT 30 CHECK (drain_bound_s BETWEEN 0 AND 30),
    drain_elapsed_ms      integer NOT NULL DEFAULT 0 CHECK (drain_elapsed_ms >= 0),
    todo_updated          boolean NOT NULL DEFAULT false,
    kill_switch_bypass    boolean NOT NULL DEFAULT false,
    reason                text NOT NULL DEFAULT '',
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_uplift_delivery_records_session_created
    ON uplift_delivery_records (session_id, created_at);
