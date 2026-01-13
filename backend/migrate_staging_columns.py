"""
Migration script to add pallet tracking columns to staging_items table
Run this script to update the database schema: python migrate_staging_columns.py
"""
from sqlalchemy import text
from app.database import engine, SessionLocal
from app.config import settings

def migrate_staging_items_table():
    """Add new columns to staging_items table if they don't exist"""
    
    print("Starting migration for staging_items table...")
    print(f"Database: {settings.DATABASE_URL.split('@')[-1] if '@' in settings.DATABASE_URL else 'Unknown'}")
    
    db = SessionLocal()
    try:
        # Check if columns exist and add them if they don't
        migration_sql = """
        DO $$
        BEGIN
            -- Add pallets_staged column
            IF NOT EXISTS (
                SELECT 1 FROM information_schema.columns 
                WHERE table_name = 'staging_items' AND column_name = 'pallets_staged'
            ) THEN
                ALTER TABLE staging_items ADD COLUMN pallets_staged FLOAT;
                RAISE NOTICE 'Added column: pallets_staged';
            ELSE
                RAISE NOTICE 'Column pallets_staged already exists';
            END IF;

            -- Add pallets_used column
            IF NOT EXISTS (
                SELECT 1 FROM information_schema.columns 
                WHERE table_name = 'staging_items' AND column_name = 'pallets_used'
            ) THEN
                ALTER TABLE staging_items ADD COLUMN pallets_used FLOAT DEFAULT 0;
                RAISE NOTICE 'Added column: pallets_used';
            ELSE
                RAISE NOTICE 'Column pallets_used already exists';
            END IF;

            -- Add pallets_returned column
            IF NOT EXISTS (
                SELECT 1 FROM information_schema.columns 
                WHERE table_name = 'staging_items' AND column_name = 'pallets_returned'
            ) THEN
                ALTER TABLE staging_items ADD COLUMN pallets_returned FLOAT DEFAULT 0;
                RAISE NOTICE 'Added column: pallets_returned';
            ELSE
                RAISE NOTICE 'Column pallets_returned already exists';
            END IF;

            -- Add original_storage_row_id column
            IF NOT EXISTS (
                SELECT 1 FROM information_schema.columns 
                WHERE table_name = 'staging_items' AND column_name = 'original_storage_row_id'
            ) THEN
                ALTER TABLE staging_items ADD COLUMN original_storage_row_id VARCHAR(50);
                RAISE NOTICE 'Added column: original_storage_row_id';
            ELSE
                RAISE NOTICE 'Column original_storage_row_id already exists';
            END IF;

            -- Add staging_storage_row_id column
            IF NOT EXISTS (
                SELECT 1 FROM information_schema.columns 
                WHERE table_name = 'staging_items' AND column_name = 'staging_storage_row_id'
            ) THEN
                ALTER TABLE staging_items ADD COLUMN staging_storage_row_id VARCHAR(50);
                RAISE NOTICE 'Added column: staging_storage_row_id';
            ELSE
                RAISE NOTICE 'Column staging_storage_row_id already exists';
            END IF;

            -- Add foreign key constraints
            IF NOT EXISTS (
                SELECT 1 FROM information_schema.table_constraints 
                WHERE constraint_name = 'staging_items_original_storage_row_id_fkey'
                AND table_name = 'staging_items'
            ) THEN
                ALTER TABLE staging_items
                ADD CONSTRAINT staging_items_original_storage_row_id_fkey
                FOREIGN KEY (original_storage_row_id) REFERENCES storage_rows(id);
                RAISE NOTICE 'Added foreign key: original_storage_row_id';
            ELSE
                RAISE NOTICE 'Foreign key original_storage_row_id already exists';
            END IF;

            IF NOT EXISTS (
                SELECT 1 FROM information_schema.table_constraints 
                WHERE constraint_name = 'staging_items_staging_storage_row_id_fkey'
                AND table_name = 'staging_items'
            ) THEN
                ALTER TABLE staging_items
                ADD CONSTRAINT staging_items_staging_storage_row_id_fkey
                FOREIGN KEY (staging_storage_row_id) REFERENCES storage_rows(id);
                RAISE NOTICE 'Added foreign key: staging_storage_row_id';
            ELSE
                RAISE NOTICE 'Foreign key staging_storage_row_id already exists';
            END IF;

            -- Update existing rows to set default values
            UPDATE staging_items 
            SET pallets_used = 0 
            WHERE pallets_used IS NULL;

            UPDATE staging_items 
            SET pallets_returned = 0 
            WHERE pallets_returned IS NULL;

            RAISE NOTICE 'Migration completed successfully!';
        END $$;
        """
        
        # Execute the migration
        result = db.execute(text(migration_sql))
        db.commit()
        
        print("\n✅ Migration completed successfully!")
        print("Added columns: pallets_staged, pallets_used, pallets_returned, original_storage_row_id, staging_storage_row_id")
        print("You can now restart your backend server and the staging overview should work.")
        
    except Exception as e:
        db.rollback()
        print(f"\n❌ Migration failed: {str(e)}")
        print("\nIf you're seeing permission errors, you may need to run this with proper database credentials.")
        raise
    finally:
        db.close()

if __name__ == "__main__":
    try:
        migrate_staging_items_table()
    except Exception as e:
        print(f"\nError: {str(e)}")
        import traceback
        traceback.print_exc()
        exit(1)
