-- Data backfill for Phase 3 Task 3.3 (warehouse_id consistency).
--
-- The code fixes only NEW drift. Existing pallet_licences and inventory_transfers
-- that were created with warehouse_id = NULL (forklift users without a warehouse,
-- scanner internal transfers) remain invisible to ship-out pickers until their
-- warehouse_id is backfilled from where they physically sit.
--
-- REVIEW the SELECTs before running the UPDATEs. Run inside a transaction and
-- verify counts. NOT run automatically.

BEGIN;

-- 1. Pallet licences: derive the warehouse from the row they occupy
--    (storage_row -> storage_area -> location.warehouse_id).
--    Preview:
-- SELECT pl.id, pl.licence_number, l.warehouse_id AS resolved
-- FROM pallet_licences pl
-- JOIN storage_rows sr   ON sr.id = pl.storage_row_id
-- JOIN storage_areas sa  ON sa.id = sr.storage_area_id
-- JOIN locations l       ON l.id = sa.location_id
-- WHERE pl.warehouse_id IS NULL AND l.warehouse_id IS NOT NULL;

UPDATE pallet_licences pl
SET warehouse_id = l.warehouse_id
FROM storage_rows sr
JOIN storage_areas sa ON sa.id = sr.storage_area_id
JOIN locations l      ON l.id = sa.location_id
WHERE pl.storage_row_id = sr.id
  AND pl.warehouse_id IS NULL
  AND l.warehouse_id IS NOT NULL;

-- 1b. Fallback for pallets whose row links via sub_location instead of area.
UPDATE pallet_licences pl
SET warehouse_id = l.warehouse_id
FROM storage_rows sr
JOIN sub_locations subl ON subl.id = sr.sub_location_id
JOIN locations l        ON l.id = subl.location_id
WHERE pl.storage_row_id = sr.id
  AND pl.warehouse_id IS NULL
  AND l.warehouse_id IS NOT NULL;

-- 2. Inventory transfers created without a warehouse: inherit from their receipt.
UPDATE inventory_transfers t
SET warehouse_id = r.warehouse_id
FROM receipts r
WHERE t.receipt_id = r.id
  AND t.warehouse_id IS NULL
  AND r.warehouse_id IS NOT NULL;

-- Verify what (if anything) is still NULL and needs manual attention:
-- SELECT count(*) FROM pallet_licences WHERE warehouse_id IS NULL AND status = 'in_stock';
-- SELECT count(*) FROM inventory_transfers WHERE warehouse_id IS NULL AND status = 'pending';

COMMIT;
