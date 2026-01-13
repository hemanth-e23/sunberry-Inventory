#!/usr/bin/env python3
"""
Script to seed default category groups in the database
"""
import sys
from app.database import SessionLocal
from app.models import CategoryGroup

def seed_category_groups():
    """Create default category groups if they don't exist"""
    db = SessionLocal()
    try:
        # Default category groups
        default_groups = [
            {
                "id": "group-raw",
                "name": "Raw Materials",
                "description": "Raw materials and ingredients",
                "is_active": True
            },
            {
                "id": "group-finished",
                "name": "Finished Goods",
                "description": "Finished products ready for sale",
                "is_active": True
            },
            {
                "id": "group-packaging",
                "name": "Packaging Materials",
                "description": "Packaging and container materials",
                "is_active": True
            }
        ]
        
        created_count = 0
        for group_data in default_groups:
            # Check if group already exists
            existing_group = db.query(CategoryGroup).filter(CategoryGroup.id == group_data["id"]).first()
            
            if not existing_group:
                # Create the group
                new_group = CategoryGroup(**group_data)
                db.add(new_group)
                created_count += 1
                print(f"Created category group: {group_data['name']} ({group_data['id']})")
            else:
                print(f"Category group already exists: {group_data['name']} ({group_data['id']})")
        
        db.commit()
        
        if created_count > 0:
            print(f"\nSuccessfully created {created_count} category group(s)!")
        else:
            print("\nAll category groups already exist.")
            
    except Exception as e:
        print(f"Error seeding category groups: {e}")
        db.rollback()
        sys.exit(1)
    finally:
        db.close()

if __name__ == "__main__":
    seed_category_groups()
