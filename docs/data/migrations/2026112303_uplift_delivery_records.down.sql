-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Task Tdfe6-data / correlation dfe6b075-b574-47af-9556-0c7845221d85
-- Rollback for 2026112303: removes only the table the forward created.
-- The DROP is confined to the rollback path (L2 additive forward is safe).
SET lock_timeout = '5s';

DROP TABLE IF EXISTS uplift_delivery_records;
