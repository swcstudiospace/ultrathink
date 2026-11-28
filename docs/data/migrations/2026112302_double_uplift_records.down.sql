-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Task Tdde6-data / correlation dde6accb-e288-424f-8913-cb429e5f88ef
-- Rollback for 2026112302: removes only the table the forward created.
-- The DROP is confined to the rollback path (L2 additive forward is safe).
SET lock_timeout = '5s';

DROP TABLE IF EXISTS double_uplift_records;
