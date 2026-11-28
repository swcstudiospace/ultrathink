-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Task T3b18-data / correlation 3b18f741-390c-4422-bdd2-4b18499c4490
-- Rollback for 2026.11.23-01: removes only the table the forward created.
-- The DROP is confined to the rollback path (L2 additive forward is safe).
SET lock_timeout = '5s';

DROP TABLE IF EXISTS phase_dispatch_records;
