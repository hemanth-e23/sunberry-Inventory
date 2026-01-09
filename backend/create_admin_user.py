#!/usr/bin/env python3
"""
Script to create an admin user in the database
"""
import sys
import uuid
from app.database import SessionLocal
from app.models import User
from app.utils.auth import get_password_hash

def create_admin_user():
    """Create admin user if it doesn't exist"""
    db = SessionLocal()
    try:
        # Check if admin user already exists
        admin_user = db.query(User).filter(User.username == "admin").first()
        
        if admin_user:
            print("Admin user already exists!")
            return
        
        # Create admin user
        admin_user = User(
            id=f"user-{uuid.uuid4().hex[:12]}",
            username="admin",
            name="Administrator",
            email="admin@sunberry.com",
            hashed_password=get_password_hash("admin123"),
            role="admin",
            is_active=True
        )
        
        db.add(admin_user)
        db.commit()
        db.refresh(admin_user)
        
        print("Admin user created successfully!")
        print(f"Username: admin")
        print(f"Password: admin123")
        
    except Exception as e:
        print(f"Error creating admin user: {e}")
        db.rollback()
        sys.exit(1)
    finally:
        db.close()

if __name__ == "__main__":
    create_admin_user()

