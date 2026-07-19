"""SCIM 2.0 connector (RFC 7644).

Maps the uniform operations onto SCIM /Users and /Groups endpoints. Kept
declarative so any SCIM-compliant IdP/app (Okta, Entra provisioning, etc.)
works with only config. Reference implementation over httpx.
"""
from __future__ import annotations

import httpx

from .base import Connector, ConnectorResult, UserContext


class ScimConnector(Connector):
    type = "SCIM"
    label = "SCIM 2.0"

    def _client(self) -> httpx.Client:
        headers = {"Content-Type": "application/scim+json"}
        token = self.credentials.get("token")
        if token:
            headers["Authorization"] = f"Bearer {token}"
        return httpx.Client(base_url=self.config.get("base_url", ""), headers=headers, timeout=10.0)

    def _scim_user(self, user: UserContext) -> dict:
        return {
            "schemas": ["urn:ietf:params:scim:schemas:core:2.0:User"],
            "userName": user.email,
            "displayName": user.display_name,
            "active": True,
            "emails": [{"value": user.email, "primary": True}],
            "externalId": user.employee_id,
        }

    def _guard(self, fn) -> ConnectorResult:
        try:
            resp = fn()
        except httpx.HTTPError as exc:
            return ConnectorResult.failure(f"transport error: {exc}", retryable=True)
        if resp.status_code >= 500 or resp.status_code == 429:
            return ConnectorResult.failure(f"HTTP {resp.status_code}", retryable=True)
        if resp.status_code >= 400:
            return ConnectorResult.failure(f"HTTP {resp.status_code}")
        return ConnectorResult.success(f"HTTP {resp.status_code}")

    def test_connection(self) -> ConnectorResult:
        with self._client() as c:
            return self._guard(lambda: c.get("/ServiceProviderConfig"))

    def sync_users(self) -> ConnectorResult:
        with self._client() as c:
            return self._guard(lambda: c.get("/Users"))

    def create_user(self, user: UserContext) -> ConnectorResult:
        with self._client() as c:
            return self._guard(lambda: c.post("/Users", json=self._scim_user(user)))

    def update_user(self, user: UserContext) -> ConnectorResult:
        with self._client() as c:
            return self._guard(
                lambda: c.patch(
                    f"/Users/{user.account_identifier or user.email}",
                    json={"Operations": [{"op": "replace", "value": {"displayName": user.display_name}}]},
                )
            )

    def disable_user(self, user: UserContext) -> ConnectorResult:
        with self._client() as c:
            return self._guard(
                lambda: c.patch(
                    f"/Users/{user.account_identifier or user.email}",
                    json={"Operations": [{"op": "replace", "value": {"active": False}}]},
                )
            )

    def delete_user(self, user: UserContext) -> ConnectorResult:
        with self._client() as c:
            return self._guard(lambda: c.delete(f"/Users/{user.account_identifier or user.email}"))

    def assign_group(self, user: UserContext) -> ConnectorResult:
        with self._client() as c:
            return self._guard(
                lambda: c.patch(
                    f"/Groups/{user.group_name}",
                    json={"Operations": [{"op": "add", "path": "members",
                                          "value": [{"value": user.account_identifier or user.email}]}]},
                )
            )

    def revoke_group(self, user: UserContext) -> ConnectorResult:
        with self._client() as c:
            return self._guard(
                lambda: c.patch(
                    f"/Groups/{user.group_name}",
                    json={"Operations": [{"op": "remove", "path": f'members[value eq "{user.email}"]'}]},
                )
            )

    def list_accounts(self, since: str | None = None) -> ConnectorResult:
        params = {}
        if since:
            # SCIM filter expression for incremental pulls (RFC 7644 §3.4.2.2).
            params["filter"] = f'meta.lastModified gt "{since}"'
        try:
            with self._client() as c:
                resp = c.get("/Users", params=params)
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
        resources = body.get("Resources", [])
        accounts = []
        latest_modified: str | None = None
        for res in resources:
            emails = res.get("emails", [])
            email = next((e["value"] for e in emails if e.get("primary")), emails[0]["value"] if emails else None)
            modified = (res.get("meta") or {}).get("lastModified")
            if modified and (latest_modified is None or modified > latest_modified):
                latest_modified = modified
            accounts.append({
                "identifier": res.get("id") or res.get("userName"),
                "email": email or res.get("userName"),
                "display_name": res.get("displayName"),
                "status": "ACTIVE" if res.get("active", True) else "DISABLED",
                "groups": [g.get("display") for g in res.get("groups", []) if g.get("display")],
                "department": None,
            })
        return ConnectorResult.success("listed", accounts=accounts, cursor=latest_modified or since)
