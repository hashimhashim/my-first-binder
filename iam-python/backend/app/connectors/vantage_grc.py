"""Vantage GRC connector — the second application managed by IAM, proving the
connector framework generalizes beyond the Aegis SIEM shape.

Deliberately different from AegisSiemConnector in every way that matters for
proving reuse: PUT-upsert semantics instead of POST-then-verify, a status
field instead of a boolean flag, "entitlements" instead of "roles", an API key
header instead of a bearer token. Same JML pipeline, same UserContext, same
ConnectorResult contract — none of that changed, only the wire format did.

Mapping (framework term -> Vantage GRC concept):
    account_identifier   -> GRC identity id (the employee's email by default)
    group_name            -> GRC entitlement (a RoleEntitlement's group_name is
                             the entitlement granted by that business role)
    assign_group           -> grant an entitlement
    revoke_group            -> remove an entitlement

Expected Vantage GRC REST contract (all paths overridable via config.paths;
defaults shown). Auth: API key from credentials["api_key"], sent as
X-Api-Key.

    GET    /v1/ping                                     test_connection
    GET    /v1/identities                                list (sync); returns
                                                          {"identities":[...],
                                                           "nextCursor":...}
                                                          each: {id, email,
                                                          fullName, riskDomain,
                                                          status, entitlements}
    PUT    /v1/identities/{id}                            upsert identity
                                                          (create-or-update;
                                                           idempotent by design)
    GET    /v1/identities/{id}                            verify an identity
                                                          exists
    PATCH  /v1/identities/{id}/status                     body {"status":
                                                          "enabled"|"disabled"}
    DELETE /v1/identities/{id}                            delete (config-gated)
    PUT    /v1/identities/{id}/entitlements/{name}         grant entitlement
                                                          (idempotent)
    DELETE /v1/identities/{id}/entitlements/{name}         revoke entitlement

config:  {"base_url": "https://grc.internal", "delete_enabled": false,
          "verify_provisioning": true, "paths": {…overrides…}}
credentials: {"api_key": "…"}   (stored encrypted; never logged)

To point at a real Vantage GRC whose API differs, override `config.paths`
(and, if needed, adjust `_identity_payload` field names) — no other change.
"""
from __future__ import annotations

from typing import Any

import httpx

from .base import Connector, ConnectorResult, UserContext

_DEFAULT_PATHS = {
    "health": "/v1/ping",
    "list_identities": "/v1/identities",
    "upsert_identity": "/v1/identities/{id}",
    "get_identity": "/v1/identities/{id}",
    "status_identity": "/v1/identities/{id}/status",
    "delete_identity": "/v1/identities/{id}",
    "assign_entitlement": "/v1/identities/{id}/entitlements/{name}",
    "revoke_entitlement": "/v1/identities/{id}/entitlements/{name}",
}


class VantageGrcConnector(Connector):
    type = "VANTAGE_GRC"
    label = "Vantage GRC"

    # -- helpers ---------------------------------------------------------------
    def _path(self, key: str, **fmt: str) -> str:
        template = {**_DEFAULT_PATHS, **self.config.get("paths", {})}[key]
        return template.format(**fmt)

    #: optional httpx transport for tests (e.g. httpx.MockTransport); None in prod
    transport: httpx.BaseTransport | None = None

    def _client(self) -> httpx.Client:
        headers = {"Content-Type": "application/json"}
        api_key = self.credentials.get("api_key")
        if api_key:
            headers["X-Api-Key"] = api_key
        return httpx.Client(
            base_url=self.config.get("base_url", ""), headers=headers, timeout=10.0,
            transport=self.transport,
        )

    @staticmethod
    def _identity_id(user: UserContext) -> str:
        return user.account_identifier or user.email

    def _identity_payload(self, user: UserContext) -> dict[str, Any]:
        return {
            "email": user.email,
            "fullName": user.display_name,
            "riskDomain": user.department,
            "externalId": user.employee_id,
            "status": "enabled",
        }

    @staticmethod
    def _classify(resp: httpx.Response, context: str) -> ConnectorResult:
        if resp.status_code < 400:
            return ConnectorResult.success(f"{context}: HTTP {resp.status_code}")
        if resp.status_code >= 500 or resp.status_code == 429:
            return ConnectorResult.failure(f"{context}: HTTP {resp.status_code}", retryable=True)
        return ConnectorResult.failure(f"{context}: HTTP {resp.status_code}")

    # -- capabilities ----------------------------------------------------------
    def test_connection(self) -> ConnectorResult:
        try:
            with self._client() as c:
                return self._classify(c.get(self._path("health")), "health")
        except httpx.HTTPError as exc:
            return ConnectorResult.failure(f"transport error: {exc}", retryable=True)

    def sync_users(self) -> ConnectorResult:
        return self.list_accounts()

    def create_user(self, user: UserContext) -> ConnectorResult:
        # PUT is an upsert here, so "create" is naturally idempotent — no
        # 409/duplicate branch needed, unlike a POST-based API.
        ident = self._identity_id(user)
        try:
            with self._client() as c:
                resp = c.put(self._path("upsert_identity", id=ident), json=self._identity_payload(user))
                result = self._classify(resp, "upsert_identity")
                if not result.ok:
                    return result
                if self.config.get("verify_provisioning", True):
                    check = c.get(self._path("get_identity", id=ident))
                    if check.status_code >= 400:
                        return ConnectorResult.failure(
                            f"upsert reported success but verification GET returned HTTP {check.status_code}",
                            retryable=True,
                        )
                return ConnectorResult.success("identity upserted and verified", identifier=ident)
        except httpx.HTTPError as exc:
            return ConnectorResult.failure(f"transport error: {exc}", retryable=True)

    def update_user(self, user: UserContext) -> ConnectorResult:
        # Same upsert semantics as create — PUT overwrites whether the
        # identity existed or not.
        return self.create_user(user)

    def disable_user(self, user: UserContext) -> ConnectorResult:
        return self._set_status(user, "disabled")

    def enable_user(self, user: UserContext) -> ConnectorResult:
        return self._set_status(user, "enabled")

    def _set_status(self, user: UserContext, status: str) -> ConnectorResult:
        try:
            with self._client() as c:
                resp = c.patch(
                    self._path("status_identity", id=self._identity_id(user)),
                    json={"status": status},
                )
                return self._classify(resp, f"status={status}")
        except httpx.HTTPError as exc:
            return ConnectorResult.failure(f"transport error: {exc}", retryable=True)

    def delete_user(self, user: UserContext) -> ConnectorResult:
        # Deletion is destructive; gated by config and off by default so
        # ungated jobs route to the manual queue rather than silently deleting.
        if not self.config.get("delete_enabled", False):
            return ConnectorResult.failure("delete_user disabled by config (delete_enabled=false)")
        try:
            with self._client() as c:
                resp = c.delete(self._path("delete_identity", id=self._identity_id(user)))
                if resp.status_code == 404:  # already gone — idempotent success
                    return ConnectorResult.success("identity already absent")
                return self._classify(resp, "delete_identity")
        except httpx.HTTPError as exc:
            return ConnectorResult.failure(f"transport error: {exc}", retryable=True)

    def assign_group(self, user: UserContext) -> ConnectorResult:
        # group_name is the GRC entitlement.
        if not user.group_name:
            return ConnectorResult.failure("no entitlement (group_name) supplied")
        try:
            with self._client() as c:
                resp = c.put(
                    self._path("assign_entitlement", id=self._identity_id(user), name=user.group_name)
                )
                return self._classify(resp, "assign_entitlement")
        except httpx.HTTPError as exc:
            return ConnectorResult.failure(f"transport error: {exc}", retryable=True)

    def revoke_group(self, user: UserContext) -> ConnectorResult:
        if not user.group_name:
            return ConnectorResult.failure("no entitlement (group_name) supplied")
        try:
            with self._client() as c:
                resp = c.delete(
                    self._path("revoke_entitlement", id=self._identity_id(user), name=user.group_name)
                )
                if resp.status_code == 404:  # entitlement not present — idempotent
                    return ConnectorResult.success("entitlement already absent")
                return self._classify(resp, "revoke_entitlement")
        except httpx.HTTPError as exc:
            return ConnectorResult.failure(f"transport error: {exc}", retryable=True)

    def list_accounts(self, since: str | None = None) -> ConnectorResult:
        params = {"since": since} if since else None
        try:
            with self._client() as c:
                resp = c.get(self._path("list_identities"), params=params)
        except httpx.HTTPError as exc:
            return ConnectorResult.failure(f"transport error: {exc}", retryable=True)
        if resp.status_code >= 500 or resp.status_code == 429:
            return ConnectorResult.failure(f"HTTP {resp.status_code}", retryable=True)
        if resp.status_code >= 400:
            return ConnectorResult.failure(f"HTTP {resp.status_code}")
        try:
            body = resp.json()
        except ValueError:
            return ConnectorResult.failure("response was not valid JSON")
        raw = body if isinstance(body, list) else body.get("identities", [])
        accounts = [
            {
                "identifier": u.get("id") or u.get("email"),
                "email": u.get("email"),
                "display_name": u.get("fullName"),
                "status": "ACTIVE" if u.get("status") == "enabled" else "DISABLED",
                "groups": u.get("entitlements", []),  # entitlements map to framework groups
                "department": u.get("riskDomain"),
            }
            for u in raw
        ]
        cursor = body.get("nextCursor") if isinstance(body, dict) else None
        return ConnectorResult.success("listed", accounts=accounts, cursor=cursor)
