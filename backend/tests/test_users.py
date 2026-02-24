"""
Integration tests for users API.
"""
import pytest


@pytest.mark.integration
def test_create_user_requires_admin(client, auth_headers):
    """Warehouse user cannot create users."""
    response = client.post(
        "/api/users/",
        json={
            "username": "newwarehouse",
            "name": "New Warehouse",
            "email": "warehouse2@sunberry.com",
            "password": "password123",
            "role": "warehouse",
        },
        headers=auth_headers,
    )
    assert response.status_code == 403


@pytest.mark.integration
def test_create_user_as_admin(client, admin_auth_headers, db_session):
    """Admin can create users."""
    from app.models import User

    response = client.post(
        "/api/users/",
        json={
            "username": "supervisor1",
            "name": "Supervisor One",
            "email": "supervisor@sunberry.com",
            "password": "password123",
            "role": "supervisor",
        },
        headers=admin_auth_headers,
    )
    assert response.status_code == 200
    data = response.json()
    assert data["username"] == "supervisor1"
    assert data["role"] == "supervisor"
    assert "id" in data

    user = db_session.query(User).filter(User.username == "supervisor1").first()
    assert user is not None
    assert user.hashed_password is not None


@pytest.mark.integration
def test_get_users_requires_admin(client, auth_headers):
    """Warehouse cannot list users."""
    response = client.get("/api/users/", headers=auth_headers)
    assert response.status_code == 403


@pytest.mark.integration
def test_get_users_as_admin(client, admin_auth_headers, test_user):
    """Admin can list users."""
    response = client.get("/api/users/", headers=admin_auth_headers)
    assert response.status_code == 200
    data = response.json()
    assert isinstance(data, list)
    assert len(data) >= 1
    usernames = [u["username"] for u in data]
    assert "testworker" in usernames or "admin" in usernames


@pytest.mark.integration
def test_get_user_by_id_as_admin(client, admin_auth_headers, test_user):
    """Admin can get user by ID."""
    response = client.get(
        f"/api/users/{test_user.id}",
        headers=admin_auth_headers,
    )
    assert response.status_code == 200
    assert response.json()["id"] == test_user.id


@pytest.mark.integration
def test_get_user_not_found(client, admin_auth_headers):
    """Non-existent user returns 404."""
    response = client.get(
        "/api/users/nonexistent-user-id",
        headers=admin_auth_headers,
    )
    assert response.status_code == 404


@pytest.mark.integration
def test_create_user_duplicate_username(client, admin_auth_headers, test_user):
    """Cannot create user with existing username."""
    response = client.post(
        "/api/users/",
        json={
            "username": "testworker",
            "name": "Duplicate",
            "email": "dup@sunberry.com",
            "password": "password123",
            "role": "warehouse",
        },
        headers=admin_auth_headers,
    )
    assert response.status_code == 400
