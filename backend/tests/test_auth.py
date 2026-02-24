"""
Integration tests for authentication API.
"""
import pytest


@pytest.mark.integration
def test_login_success(client, test_user):
    """Valid credentials return access token."""
    response = client.post(
        "/api/auth/login",
        json={"username": "testworker", "password": "testpassword123"},
    )
    assert response.status_code == 200
    data = response.json()
    assert "access_token" in data
    assert data["token_type"] == "bearer"


@pytest.mark.integration
def test_login_invalid_password(client, test_user):
    """Invalid password returns 401."""
    response = client.post(
        "/api/auth/login",
        json={"username": "testworker", "password": "wrongpassword"},
    )
    assert response.status_code == 401


@pytest.mark.integration
def test_login_invalid_username(client):
    """Invalid username returns 401."""
    response = client.post(
        "/api/auth/login",
        json={"username": "nonexistent", "password": "anypassword"},
    )
    assert response.status_code == 401


@pytest.mark.integration
def test_get_me_with_valid_token(client, auth_headers, test_user):
    """Valid token returns current user info."""
    response = client.get("/api/auth/me", headers=auth_headers)
    assert response.status_code == 200
    data = response.json()
    assert data["username"] == "testworker"
    assert data["email"] == "test@sunberry.com"
    assert data["role"] == "warehouse"


@pytest.mark.integration
def test_get_me_without_token(client):
    """No token returns 403."""
    response = client.get("/api/auth/me")
    assert response.status_code == 403


@pytest.mark.integration
def test_register_requires_admin(client, auth_headers):
    """Non-admin cannot register new users."""
    response = client.post(
        "/api/auth/register",
        json={
            "username": "newuser",
            "name": "New User",
            "email": "new@sunberry.com",
            "password": "password123",
            "role": "warehouse",
        },
        headers=auth_headers,
    )
    assert response.status_code == 403


@pytest.mark.integration
def test_register_as_admin(client, admin_auth_headers):
    """Admin can register new users."""
    response = client.post(
        "/api/auth/register",
        json={
            "username": "newworker",
            "name": "New Worker",
            "email": "newworker@sunberry.com",
            "password": "password123",
            "role": "warehouse",
        },
        headers=admin_auth_headers,
    )
    assert response.status_code == 200
    data = response.json()
    assert data["username"] == "newworker"
    assert data["role"] == "warehouse"
    assert "id" in data


@pytest.mark.integration
def test_register_duplicate_username(client, admin_auth_headers, test_user):
    """Cannot register with existing username."""
    response = client.post(
        "/api/auth/register",
        json={
            "username": "testworker",
            "name": "Another",
            "email": "another@sunberry.com",
            "password": "password123",
            "role": "warehouse",
        },
        headers=admin_auth_headers,
    )
    assert response.status_code == 400
