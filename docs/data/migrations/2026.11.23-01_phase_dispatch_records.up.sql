-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Task T3b18-data / correlation 3b18f741-390c-4422-bdd2-4b18499c4490
-- Forward (expand): PhaseDispatchRecord provenance table.
-- Prepared only; execution is via A11 ephemeral/provisioned databases, never
-- by this agent. No existing table is touched (additive, no lock on
-- populated tables). Rollback: 2026.11.23-01_phase_dispatch_records.down.sql
SET lock_timeout = '5s';

CREATE TABLE phase_dispatch_records (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    phase_type     text NOT NULL CHECK (phase_type IN ('discuss', 'plan', 'execute', 'review')),
    playbook       text NOT NULL CHECK (playbook IN ('investigation', 'multi-phase-plan', 'feature', 'shipping')),
    state          text NOT NULL CHECK (state IN ('ok', 'disabled', 'unresolvable', 'forced-off', 'blocked')),
    fallback       text NOT NULL CHECK (fallback IN ('vanilla', 'blocked')),
    strict         boolean NOT NULL DEFAULT false,
    reason         text NOT NULL DEFAULT '',
    summary_line   text,
    units          jsonb NOT NULL DEFAULT '[]'::jsonb,
    correlation_id text NOT NULL DEFAULT '',
    task_id        text,
    created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_phase_dispatch_records_phase_created
    ON phase_dispatch_records (phase_type, created_at);
