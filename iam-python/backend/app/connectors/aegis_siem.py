"""Aegis SIEM connector — the first application managed by IAM.

IAM is the source of truth for identity; the Aegis SIEM is a managed
downstream application. This connector translates the framework's uniform
provisioning operations into Aegis SIEM REST calls, so the existing JML +
provisioning pipeline drives SIEM user/role state with no bespoke logic.

It reuses everything already in the platform — connector framework, audit,
RBAC, provisioning jobs, encrypted credential storage — and adds only the
SIEM-specific endpoint/field mapping and provisioning verification.

Mapping (framework term -> SIEM concept):
    account_identifier   -> SIEM username (the employee's email by default)
    group_name           -> SIEM role  (a RoleEntitlement's group_name is the
                            SIEM role granted by that business role)
    assign_group         -> grant a SIEM role
    revoke_group         -> remove a SIEM role

Expected Aegis SIEM REST contract (all paths overridable via config.paths;
defaults shown). Auth: Bearer token from credentials["token"].

    GET    /api/health                          test_connection
    GET    /api/users                           list users (sync); returns
                                                 [{username,email,displayName,
                                                   active,roles,department}] or
                                                 {"users":[...],"cursor":...}
    POST   /api/users                           create user
    GET    /api/users/{username}                verify a user exists
    PATCH  /api/users/{username}                update user
    POST   /api/users/{username}/disable        disable user
    POST   /api/users/{username}/enable         enable user
    DELETE /api/users/{username}                delete user (config-gated)
    POST   /api/users/{username}/roles          assign role  (body {"role": …})
    DELETE /api/users/{username}/roles/{role}   remove role

config:  {"base_url": "https://siem.internal", "delete_enabled": false,
          "verify_provisioning": true, "paths": {…overrides…}}
credentials: {"token": "…"}   (stored encrypted; never logged)

To point at a real Aegis SIEM whose API differs, override `config.paths`
(and, if needed, adjust `_user_payload` field names) — no other change.
"""
from __future__ import annotations

from typing import Any

import httpx

from .base import Connector, ConnectorResult, UserContext

_DEFAULT_PATHS = {
    "health": "/api/health",
    "list_users": "/api/users",
    "create_user": "/api/users",
    "get_user": "/api/users/{username}",
    "update_user": "/api/users/{username}",
    "disable_user": "/api/users/{username}/disable",
    "enable_user": "/api/users/{username}/enable",
    "delete_user": "/api/users/{username}",
    "assign_role": "/api/users/{username}/roles",
    "remove_role": "/api/users/{username}/roles/{role}",
}


class AegisSiemConnector(Connector):
    type = "AEGIS_SIEM"
    label = "Aegis SIEM"

    # -- helpers ---------------------------------------------------------------
    def _path(self, key: str, **fmt: str) -> str:
        template = {**_DEFAULT_PATHS, **self.config.get("paths", {})}[key]
        return template.format(**fmt)

    #: optional httpx transport for tests (e.g. httpx.MockTransport); None in prod
    transport: httpx.BaseTransport | None = None

    def _client(self) -> httpx.Client:
        headers = {"Content-Type": "application/json"}
        token = self.credentials.get("token")
        if token:
            headers["Authorization"] = f"Bearer {token}"
        return httpx.Client(
            base_url=self.config.get("base_url", ""), headers=headers, timeout=10.0,
            transport=self.transport,
        )

    @staticmethod
    def _username(user: UserContext) -> str:
        return user.account_identifier or user.email

    def _user_payload(self, user: UserContext) -> dict[str, Any]:
        return {
            "username": self._username(user),
            "email": user.email,
            "displayName": user.display_name,
            "department": user.department,
            "externalId": user.employee_id,
            "active": True,
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
        username = self._username(user)
        try:
            with self._client() as c:
                resp = c.post(self._path("create_user"), json=self._user_payload(user))
                # Idempotent: a 409/duplicate is success (the account exists).
                if resp.status_code == 409 or (resp.status_code == 400 and _already_exists(resp)):
                    result = ConnectorResult.success("user already exists")
                else:
                    result = self._classify(resp, "create_user")
                if not result.ok:
                    return result
                # Verify provisioning success (optional, on by default).
                if self.config.get("verify_provisioning", True):
                    check = c.get(self._path("get_user", username=username))
                    if check.status_code >= 400:
                        return ConnectorResult.failure(
                            f"create reported success but verification GET returned HTTP {check.status_code}",
                            retryable=True,
                        )
                return ConnectorResult.success("user created and verified", username=username)
        except httpx.HTTPError as exc:
            return ConnectorResult.failure(f"transport error: {exc}", retryable=True)

    def update_user(self, user: UserContext) -> ConnectorResult:
        try:
            with self._client() as c:
                resp = c.patch(
                    self._path("update_user", username=self._username(user)),
                    json=self._user_payload(user),
                )
                if resp.status_code == 404:  # not there yet — create it
                    return self.create_user(user)
                return self._classify(resp, "update_user")
        except httpx.HTTPError as exc:
            return ConnectorResult.failure(f"transport error: {exc}", retryable=True)

    def disable_user(self, user: UserContext) -> ConnectorResult:
        return self._simple_post("disable_user", user, "disable_user")

    def enable_user(self, user: UserContext) -> ConnectorResult:
        return self._simple_post("enable_user", user, "enable_user")

    def delete_user(self, user: UserContext) -> ConnectorResult:
        # Deletion is destructive; gated by config and off by default so
        # ungated jobs route to the manual queue rather than silently deleting.
        if not self.config.get("delete_enabled", False):
            return ConnectorResult.failure("delete_user disabled by config (delete_enabled=false)")
        try:
            with self._client() as c:
                resp = c.delete(self._path("delete_user", username=self._username(user)))
                if resp.status_code == 404:  # already gone — idempotent success
                    return ConnectorResult.success("user already absent")
                return self._classify(resp, "delete_user")
        except httpx.HTTPError as exc:
            return ConnectorResult.failure(f"transport error: {exc}", retryable=True)

    def assign_group(self, user: UserContext) -> ConnectorResult:
        # group_name is the SIEM role.
        if not user.group_name:
            return ConnectorResult.failure("no role (group_name) supplied")
        try:
            with self._client() as c:
                resp = c.post(
                    self._path("assign_role", username=self._username(user)),
                    json={"role": user.group_name},
                )
                if resp.status_code == 409:  # already has the role
                    return ConnectorResult.success("role already assigned")
                return self._classify(resp, "assign_role")
        except httpx.HTTPError as exc:
            return ConnectorResult.failure(f"transport error: {exc}", retryable=True)

    def revoke_group(self, user: UserContext) -> ConnectorResult:
        if not user.group_name:
            return ConnectorResult.failure("no role (group_name) supplied")
        try:
            with self._client() as c:
                resp = c.delete(self._path("remove_role", username=self._username(user), role=user.group_name))
                if resp.status_code == 404:  # role not present — idempotent
                    return ConnectorResult.success("role already absent")
                return self._classify(resp, "remove_role")
        except httpx.HTTPError as exc:
            return ConnectorResult.failure(f"transport error: {exc}", retryable=True)

    def list_accounts(self, since: str | None = None) -> ConnectorResult:
        params = {"since": since} if since else None
        try:
            with self._client() as c:
                resp = c.get(self._path("list_users"), params=params)
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
        raw = body if isinstance(body, list) else body.get("users", [])
        accounts = [
            {
                "identifier": u.get("username") or u.get("email"),
                "email": u.get("email"),
                "display_name": u.get("displayName") or u.get("display_name"),
                "status": "ACTIVE" if u.get("active", True) else "DISABLED",
                "groups": u.get("roles", []),  # SIEM roles map to framework groups
                "department": u.get("department"),
            }
            for u in raw
        ]
        cursor = body.get("cursor") if isinstance(body, dict) else None
        return ConnectorResult.success("listed", accounts=accounts, cursor=cursor)

    def _simple_post(self, path_key: str, user: UserContext, context: str) -> ConnectorResult:
        try:
            with self._client() as c:
                return self._classify(
                    c.post(self._path(path_key, username=self._username(user))), context
                )
        except httpx.HTTPError as exc:
            return ConnectorResult.failure(f"transport error: {exc}", retryable=True)


def _already_exists(resp: httpx.Response) -> bool:
    try:
        return "exist" in str(resp.json()).lower()
    except ValueError:
        return "exist" in resp.text.lower()
