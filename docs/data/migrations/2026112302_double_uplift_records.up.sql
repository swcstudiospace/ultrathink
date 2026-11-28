-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Task Tdde6-data / correlation dde6accb-e288-424f-8913-cb429e5f88ef
-- Forward (expand): DoubleUpliftRecord provenance table for Tdde6.
-- Prepared only; execution is via A11 ephemeral/provisioned databases, never
-- by this agent. No existing table is touched (additive, no lock on
-- populated tables). Runtime source of truth remains the session XML and
-- the JSON contract contracts/ultrathink-double-uplift.data.json; this
-- table provisions the same record in shadow/future persistent stores.
-- Version id 2026112302 (not 2026.11.23-02): data_migration_check versions
-- by the first numeric segment, so a second 2026.* file would be a duplicate.
-- Rollback: 2026112302_double_uplift_records.down.sql
SET lock_timeout = '5s';

CREATE TABLE double_uplift_records (
    id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id                text NOT NULL DEFAULT '',
    graph_id                  text NOT NULL DEFAULT '',
    prompts_total             integer NOT NULL DEFAULT 10 CHECK (prompts_total = 3 + node_count),
    uplift_passes             integer NOT NULL DEFAULT 2 CHECK (uplift_passes = 2),
    node_count                integer NOT NULL DEFAULT 7 CHECK (node_count BETWEEN 0 AND 8),
    line_count                integer NOT NULL DEFAULT 0 CHECK (line_count >= 0 AND (final_prompt_landed = false OR line_count >= 500)),
    rationale_preserved_pct   integer NOT NULL DEFAULT 100 CHECK (rationale_preserved_pct BETWEEN 0 AND 100),
    truncation_markers        integer NOT NULL DEFAULT 0 CHECK (truncation_markers = 0),
    density_loss_stage        text NOT NULL DEFAULT '',
    final_prompt_landed       boolean NOT NULL DEFAULT false,
    specialists_before_final  integer NOT NULL DEFAULT 0 CHECK (specialists_before_final = 0),
    full_prompt_beneath       boolean NOT NULL DEFAULT false,
    linked_issues             jsonb NOT NULL DEFAULT '[]'::jsonb,
    stage_metrics             jsonb NOT NULL DEFAULT '[]'::jsonb,
    prompt_accounting         text NOT NULL DEFAULT '',
    final_prompt_xml          text NOT NULL DEFAULT '',
    correlation_id            text NOT NULL DEFAULT '',
    task_id                   text,
    created_at                timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_double_uplift_records_session_created
    ON double_uplift_records (session_id, created_at);
