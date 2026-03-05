"""
One-time migration: restructure category hierarchy from type-based groups to client-based groups.

BEFORE:
  CategoryGroup: "Raw Materials"
  CategoryGroup: "Finished Goods"
  CategoryGroup: "Packaging Materials"
      └─ Categories (each has parent_id pointing to one of the above)
          └─ Products (untouched)

AFTER:
  CategoryGroup: "Sunberry"  (new — or existing if already created)
      └─ All categories move here (parent_id updated)
  Old groups are deactivated (not deleted, for safety)

Run once:
  cd backend
  python scripts/migrate_to_client_groups.py
"""

import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.database import SessionLocal
from app.models import CategoryGroup, Category

# ─── Configuration ────────────────────────────────────────────────────────────
# The new top-level client group to create
NEW_CLIENT_ID   = "sunberry"
NEW_CLIENT_NAME = "Sunberry"

# The old type-based groups to deactivate after migration
# Add/remove IDs here to match what's actually in your database
OLD_GROUP_IDS_TO_DEACTIVATE = [
    "group-raw",
    "group-finished",
    "group-packaging",
]
# ──────────────────────────────────────────────────────────────────────────────


def run():
    db = SessionLocal()
    try:
        # 1. Show current state
        old_groups = db.query(CategoryGroup).filter(
            CategoryGroup.is_active == True
        ).all()
        print("\nCurrent category groups:")
        for g in old_groups:
            count = db.query(Category).filter(Category.parent_id == g.id).count()
            print(f"  [{g.id}] {g.name}  ({count} categories)")

        categories_total = db.query(Category).count()
        print(f"\nTotal categories: {categories_total}")
        print(f"(Products are NOT affected by this migration)\n")

        # 2. Confirm
        answer = input(f"Migrate all categories → parent '{NEW_CLIENT_ID}' ({NEW_CLIENT_NAME})? [y/N] ").strip().lower()
        if answer != 'y':
            print("Aborted.")
            return

        # 3. Create (or find) the new client group
        client = db.query(CategoryGroup).filter(CategoryGroup.id == NEW_CLIENT_ID).first()
        if client:
            print(f"CategoryGroup '{NEW_CLIENT_ID}' already exists — will use it.")
            client.is_active = True
        else:
            client = CategoryGroup(
                id=NEW_CLIENT_ID,
                name=NEW_CLIENT_NAME,
                description=f"{NEW_CLIENT_NAME} — company client group",
                is_active=True,
            )
            db.add(client)
            db.flush()
            print(f"Created CategoryGroup: [{NEW_CLIENT_ID}] {NEW_CLIENT_NAME}")

        # 4. Move all categories to the new group
        updated = db.query(Category).filter(
            Category.parent_id != NEW_CLIENT_ID
        ).update({"parent_id": NEW_CLIENT_ID}, synchronize_session=False)
        print(f"Updated {updated} categories → parent_id = '{NEW_CLIENT_ID}'")

        # 5. Deactivate old groups (safe — not deleting in case of any FK references)
        deactivated = 0
        for old_id in OLD_GROUP_IDS_TO_DEACTIVATE:
            grp = db.query(CategoryGroup).filter(CategoryGroup.id == old_id).first()
            if grp and grp.id != NEW_CLIENT_ID:
                grp.is_active = False
                deactivated += 1
                print(f"Deactivated old group: [{grp.id}] {grp.name}")

        db.commit()

        # 6. Show result
        print("\n--- Migration complete ---")
        sunberry = db.query(CategoryGroup).filter(CategoryGroup.id == NEW_CLIENT_ID).first()
        cat_count = db.query(Category).filter(Category.parent_id == NEW_CLIENT_ID).count()
        print(f"  [{sunberry.id}] {sunberry.name}  →  {cat_count} categories")
        print("  Products: untouched\n")

    except Exception as e:
        db.rollback()
        print(f"\nError: {e}")
        raise
    finally:
        db.close()


if __name__ == "__main__":
    run()
