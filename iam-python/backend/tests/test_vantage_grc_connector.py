"""Vantage GRC connector tests.

Run the connector against an in-process fake GRC (httpx.MockTransport) — no
network, no live server — covering the full provisioning surface. Vantage
GRC's REST shape is deliberately unlike the Aegis SIEM fixture (PUT-upsert
instead of POST-then-409, a status string instead of a boolean, entitlements
instead of roles) to prove the framework isn't fit to one API shape.
"""
import json as _json

import httpx
import pytest

from app.connectors.base import UserContext
from app.connectors.vantage_grc import VantageGrcConnector


class FakeGrc:
    """Minimal in-memory GRC implementing the connector's REST contract."""

    def __init__(self):
        self.identities: dict[str, dict] = {}
        self.calls: list[str] = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.calls.append(f"{request.method} {request.url.path}")
        parts = request.url.path.strip("/").split("/")  # v1/identities/{id}/...
        method = request.method

        if request.url.path == "/v1/ping":
            return httpx.Response(200, json={"status": "ok"})
        if request.url.path == "/v1/identities" and method == "GET":
            return httpx.Response(200, json={"identities": list(self.identities.values())})
        # /v1/identities/{id}[/...]
        if len(parts) >= 3 and parts[0] == "v1" and parts[1] == "identities":
            ident = parts[2]
            if len(parts) == 3:
                if method == "PUT":  # upsert
                    data = _json.loads(request.read())
                    existing = self.identities.get(ident, {"entitlements": []})
                    self.identities[ident] = {**existing, **data, "id": ident,
                                              "entitlements": existing["entitlements"]}
                    return httpx.Response(200, json=self.identities[ident])
                if method == "GET":
                    return (httpx.Response(200, json=self.identities[ident])
                            if ident in self.identities else httpx.Response(404))
                if method == "DELETE":
                    if ident not in self.identities:
                        return httpx.Response(404)
                    del self.identities[ident]
                    return httpx.Response(204)
            if len(parts) == 4 and parts[3] == "status" and method == "PATCH":
                if ident not in self.identities:
                    return httpx.Response(404)
                self.identities[ident]["status"] = _json.loads(request.read())["status"]
                return httpx.Response(200, json=self.identities[ident])
            if len(parts) == 5 and parts[3] == "entitlements":
                name = parts[4]
                if ident not in self.identities:
                    return httpx.Response(404)
                ents = self.identities[ident]["entitlements"]
                if method == "PUT":
                    if name not in ents:
                        ents.append(name)
                    return httpx.Response(200, json=self.identities[ident])
                if method == "DELETE":
                    if name not in ents:
                        return httpx.Response(404)
                    ents.remove(name)
                    return httpx.Response(204)
        return httpx.Response(500, json={"error": "unhandled"})


def _connector(grc: FakeGrc, **config) -> VantageGrcConnector:
    c = VantageGrcConnector({"base_url": "http://grc.test", **config}, {"api_key": "k"})
    c.transport = httpx.MockTransport(grc.handler)
    return c


def _user(email="dana@corp.com", group=None):
    return UserContext(employee_id="e1", display_name="Dana", email=email,
                       account_identifier=email, group_name=group)


def test_test_connection():
    assert _connector(FakeGrc()).test_connection().ok


def test_create_user_and_verify():
    grc = FakeGrc()
    result = _connector(grc).create_user(_user())
    assert result.ok
    assert "dana@corp.com" in grc.identities
    assert "GET /v1/identities/dana@corp.com" in grc.calls


def test_create_user_is_idempotent():
    grc = FakeGrc()
    c = _connector(grc)
    assert c.create_user(_user()).ok
    # PUT upsert: a second create overwrites, not duplicates.
    second = c.create_user(_user())
    assert second.ok
    assert len(grc.identities) == 1


def test_update_user_reuses_upsert():
    grc = FakeGrc()
    c = _connector(grc)
    assert c.update_user(_user()).ok
    assert "dana@corp.com" in grc.identities


def test_disable_and_enable():
    grc = FakeGrc()
    c = _connector(grc)
    c.create_user(_user())
    assert c.disable_user(_user()).ok
    assert grc.identities["dana@corp.com"]["status"] == "disabled"
    assert c.enable_user(_user()).ok
    assert grc.identities["dana@corp.com"]["status"] == "enabled"


def test_assign_and_revoke_entitlement():
    grc = FakeGrc()
    c = _connector(grc)
    c.create_user(_user())
    assert c.assign_group(_user(group="Compliance-Analyst")).ok
    assert grc.identities["dana@corp.com"]["entitlements"] == ["Compliance-Analyst"]
    # re-assign is idempotent (PUT is naturally idempotent)
    assert c.assign_group(_user(group="Compliance-Analyst")).ok
    assert grc.identities["dana@corp.com"]["entitlements"] == ["Compliance-Analyst"]
    assert c.revoke_group(_user(group="Compliance-Analyst")).ok
    assert grc.identities["dana@corp.com"]["entitlements"] == []
    # revoking an absent entitlement is idempotent success
    assert c.revoke_group(_user(group="Compliance-Analyst")).ok


def test_delete_is_config_gated():
    grc = FakeGrc()
    c = _connector(grc)
    c.create_user(_user())
    # default: deletion disabled -> failure (routes to manual queue), identity kept
    assert not c.delete_user(_user()).ok
    assert "dana@corp.com" in grc.identities
    # enabled -> deletes
    c2 = _connector(grc, delete_enabled=True)
    assert c2.delete_user(_user()).ok
    assert "dana@corp.com" not in grc.identities


def test_create_verification_failure_is_retryable():
    """If the upsert 'succeeds' but the identity isn't actually there, the
    connector reports a retryable failure rather than a false success."""
    grc = FakeGrc()

    def flaky(request: httpx.Request) -> httpx.Response:
        if request.method == "PUT":
            return httpx.Response(200, json={"id": "dana@corp.com"})  # claims success
        if request.method == "GET":
            return httpx.Response(404)  # but it's not really there
        return httpx.Response(500)

    c = VantageGrcConnector({"base_url": "http://grc.test"}, {})
    c.transport = httpx.MockTransport(flaky)
    result = c.create_user(_user())
    assert not result.ok
    assert result.retryable


def test_list_accounts_maps_entitlements_to_groups():
    grc = FakeGrc()
    c = _connector(grc)
    c.create_user(_user())
    c.assign_group(_user(group="Compliance-Analyst"))
    c.disable_user(_user())
    result = c.list_accounts()
    assert result.ok
    accounts = result.data["accounts"]
    assert accounts[0]["identifier"] == "dana@corp.com"
    assert accounts[0]["status"] == "DISABLED"
    assert accounts[0]["groups"] == ["Compliance-Analyst"]


if __name__ == "__main__":  # allow direct execution
    import sys
    sys.exit(pytest.main([__file__, "-q"]))
