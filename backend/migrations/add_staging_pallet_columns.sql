-- Migration: Add pallet tracking columns to staging_items table
-- Run this script to update the database schema

-- Add pallet tracking columns
ALTER TABLE staging_items 
ADD COLUMN IF NOT EXISTS pallets_staged FLOAT,
ADD COLUMN IF NOT EXISTS pallets_used FLOAT DEFAULT 0,
ADD COLUMN IF NOT EXISTS pallets_returned FLOAT DEFAULT 0,
ADD COLUMN IF NOT EXISTS original_storage_row_id VARCHAR(50),
ADD COLUMN IF NOT EXISTS staging_storage_row_id VARCHAR(50);

-- Add foreign key constraints if they don't exist
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints 
        WHERE constraint_name = 'staging_items_original_storage_row_id_fkey'
    ) THEN
        ALTER TABLE staging_items
        ADD CONSTRAINT staging_items_original_storage_row_id_fkey
        FOREIGN KEY (original_storage_row_id) REFERENCES storage_rows(id);
    END IF;
    
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints 
        WHERE constraint_name = 'staging_items_staging_storage_row_id_fkey'
    ) THEN
        ALTER TABLE staging_items
        ADD CONSTRAINT staging_items_staging_storage_row_id_fkey
        FOREIGN KEY (staging_storage_row_id) REFERENCES storage_rows(id);
    END IF;
END $$;

-- Update existing rows to have default values
UPDATE staging_items 
SET pallets_used = 0 
WHERE pallets_used IS NULL;

UPDATE staging_items 
SET pallets_returned = 0 
WHERE pallets_returned IS NULL;
