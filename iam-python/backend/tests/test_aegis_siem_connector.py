"""Aegis SIEM connector tests.

Run the connector against an in-process fake SIEM (httpx.MockTransport) — no
network, no live server — covering the full provisioning surface and its
idempotency/verification behaviour.
"""
import httpx
import pytest

from app.connectors.aegis_siem import AegisSiemConnector
from app.connectors.base import UserContext


class FakeSiem:
    """Minimal in-memory SIEM implementing the connector's REST contract."""

    def __init__(self):
        self.users: dict[str, dict] = {}
        self.calls: list[str] = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.calls.append(f"{request.method} {request.url.path}")
        parts = request.url.path.strip("/").split("/")  # api/users/{u}/...
        method = request.method

        if request.url.path == "/api/health":
            return httpx.Response(200, json={"status": "ok"})
        if request.url.path == "/api/users" and method == "GET":
            return httpx.Response(200, json={"users": list(self.users.values())})
        if request.url.path == "/api/users" and method == "POST":
            body = request.read().decode()
            import json as _json
            data = _json.loads(body)
            u = data["username"]
            if u in self.users:
                return httpx.Response(409, json={"error": "user already exists"})
            self.users[u] = {**data, "roles": []}
            return httpx.Response(201, json=self.users[u])
        # /api/users/{username}[/...]
        if len(parts) >= 3 and parts[0] == "api" and parts[1] == "users":
            username = parts[2]
            if len(parts) == 3:
                if method == "GET":
                    return (httpx.Response(200, json=self.users[username])
                            if username in self.users else httpx.Response(404))
                if method == "PATCH":
                    if username not in self.users:
                        return httpx.Response(404)
                    import json as _json
                    self.users[username].update(_json.loads(request.read()))
                    return httpx.Response(200, json=self.users[username])
                if method == "DELETE":
                    if username not in self.users:
                        return httpx.Response(404)
                    del self.users[username]
                    return httpx.Response(204)
            if len(parts) == 4 and parts[3] in ("disable", "enable"):
                if username not in self.users:
                    return httpx.Response(404)
                self.users[username]["active"] = parts[3] == "enable"
                return httpx.Response(200, json=self.users[username])
            if len(parts) == 4 and parts[3] == "roles" and method == "POST":
                if username not in self.users:
                    return httpx.Response(404)
                import json as _json
                role = _json.loads(request.read())["role"]
                if role in self.users[username]["roles"]:
                    return httpx.Response(409)
                self.users[username]["roles"].append(role)
                return httpx.Response(201, json=self.users[username])
            if len(parts) == 5 and parts[3] == "roles" and method == "DELETE":
                role = parts[4]
                if username not in self.users or role not in self.users[username]["roles"]:
                    return httpx.Response(404)
                self.users[username]["roles"].remove(role)
                return httpx.Response(204)
        return httpx.Response(500, json={"error": "unhandled"})


def _connector(siem: FakeSiem, **config) -> AegisSiemConnector:
    c = AegisSiemConnector({"base_url": "http://siem.test", **config}, {"token": "t"})
    c.transport = httpx.MockTransport(siem.handler)
    return c


def _user(email="dana@corp.com", group=None):
    return UserContext(employee_id="e1", display_name="Dana", email=email,
                       account_identifier=email, group_name=group)


def test_test_connection():
    assert _connector(FakeSiem()).test_connection().ok


def test_create_user_and_verify():
    siem = FakeSiem()
    result = _connector(siem).create_user(_user())
    assert result.ok
    assert "dana@corp.com" in siem.users
    # verification GET was issued after the create
    assert "GET /api/users/dana@corp.com" in siem.calls


def test_create_user_is_idempotent():
    siem = FakeSiem()
    c = _connector(siem)
    assert c.create_user(_user()).ok
    # second create hits 409 -> treated as success
    second = c.create_user(_user())
    assert second.ok
    assert len(siem.users) == 1


def test_disable_and_enable():
    siem = FakeSiem()
    c = _connector(siem)
    c.create_user(_user())
    assert c.disable_user(_user()).ok
    assert siem.users["dana@corp.com"]["active"] is False
    assert c.enable_user(_user()).ok
    assert siem.users["dana@corp.com"]["active"] is True


def test_assign_and_revoke_role():
    siem = FakeSiem()
    c = _connector(siem)
    c.create_user(_user())
    assert c.assign_group(_user(group="SOC-Analyst")).ok
    assert siem.users["dana@corp.com"]["roles"] == ["SOC-Analyst"]
    # re-assign is idempotent (409 -> success)
    assert c.assign_group(_user(group="SOC-Analyst")).ok
    assert c.revoke_group(_user(group="SOC-Analyst")).ok
    assert siem.users["dana@corp.com"]["roles"] == []
    # revoking an absent role is idempotent success
    assert c.revoke_group(_user(group="SOC-Analyst")).ok


def test_delete_is_config_gated():
    siem = FakeSiem()
    c = _connector(siem)
    c.create_user(_user())
    # default: deletion disabled -> failure (routes to manual queue), user kept
    assert not c.delete_user(_user()).ok
    assert "dana@corp.com" in siem.users
    # enabled -> deletes
    c2 = _connector(siem, delete_enabled=True)
    assert c2.delete_user(_user()).ok
    assert "dana@corp.com" not in siem.users


def test_create_verification_failure_is_retryable():
    """If the post 'succeeds' but the account isn't actually there, the
    connector reports a retryable failure rather than a false success."""
    siem = FakeSiem()

    def flaky(request: httpx.Request) -> httpx.Response:
        if request.method == "POST" and request.url.path == "/api/users":
            return httpx.Response(201, json={"username": "dana@corp.com"})  # claims success
        if request.method == "GET":
            return httpx.Response(404)  # but it's not really there
        return httpx.Response(500)

    c = AegisSiemConnector({"base_url": "http://siem.test"}, {})
    c.transport = httpx.MockTransport(flaky)
    result = c.create_user(_user())
    assert not result.ok
    assert result.retryable


def test_list_accounts_maps_roles_to_groups():
    siem = FakeSiem()
    c = _connector(siem)
    c.create_user(_user())
    c.assign_group(_user(group="SOC-Analyst"))
    c.disable_user(_user())
    result = c.list_accounts()
    assert result.ok
    accounts = result.data["accounts"]
    assert accounts[0]["identifier"] == "dana@corp.com"
    assert accounts[0]["status"] == "DISABLED"
    assert accounts[0]["groups"] == ["SOC-Analyst"]


if __name__ == "__main__":  # allow direct execution
    import sys
    sys.exit(pytest.main([__file__, "-q"]))
