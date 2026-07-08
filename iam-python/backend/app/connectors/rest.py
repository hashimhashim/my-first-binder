"""Generic REST connector.

Drives an application's REST API from a small declarative config map, so many
SaaS apps can be integrated without new code. Config shape (all optional
except base_url):

    {
      "base_url": "https://api.example.com",
      "paths": {
        "test": "/health",
        "create_user": "/users",
        "disable_user": "/users/{identifier}/disable",
        ...
      },
      "auth": {"type": "bearer_env", "token_env": "EXAMPLE_TOKEN"}
    }

Secrets are resolved from `credentials` (injected from secure storage), never
hard-coded. Network calls use httpx with short timeouts; connection/5xx errors
are reported retryable.
"""
from __future__ import annotations

from typing import Any

import httpx

from .base import Connector, ConnectorResult, UserContext


class RestConnector(Connector):
    type = "REST"
    label = "Generic REST API"

    def _client(self) -> httpx.Client:
        headers = {}
        token = self.credentials.get("token")
        if token:
            headers["Authorization"] = f"Bearer {token}"
        return httpx.Client(
            base_url=self.config.get("base_url", ""), headers=headers, timeout=10.0
        )

    def _call(self, op: str, user: UserContext | None = None, method: str = "POST") -> ConnectorResult:
        paths: dict[str, str] = self.config.get("paths", {})
        path = paths.get(op)
        if not path:
            return ConnectorResult.failure(f"no path configured for '{op}'")
        if user is not None:
            path = path.format(identifier=user.account_identifier or user.email, email=user.email)
        body = None
        if user is not None and method in {"POST", "PUT", "PATCH"}:
            body = {
                "employeeId": user.employee_id,
                "displayName": user.display_name,
                "email": user.email,
                "department": user.department,
                "group": user.group_name,
            }
        try:
            with self._client() as client:
                resp = client.request(method, path, json=body)
        except httpx.HTTPError as exc:  # connection/timeout
            return ConnectorResult.failure(f"transport error: {exc}", retryable=True)
        if resp.status_code >= 500 or resp.status_code == 429:
            return ConnectorResult.failure(f"HTTP {resp.status_code}", retryable=True)
        if resp.status_code >= 400:
            return ConnectorResult.failure(f"HTTP {resp.status_code}")
        return ConnectorResult.success(f"HTTP {resp.status_code}")

    def test_connection(self) -> ConnectorResult:
        return self._call("test", method="GET")

    def sync_users(self) -> ConnectorResult:
        return self._call("sync_users", method="GET")

    def create_user(self, user: UserContext) -> ConnectorResult:
        return self._call("create_user", user, "POST")

    def update_user(self, user: UserContext) -> ConnectorResult:
        return self._call("update_user", user, "PATCH")

    def disable_user(self, user: UserContext) -> ConnectorResult:
        return self._call("disable_user", user, "POST")

    def delete_user(self, user: UserContext) -> ConnectorResult:
        return self._call("delete_user", user, "DELETE")

    def assign_group(self, user: UserContext) -> ConnectorResult:
        return self._call("assign_group", user, "POST")

    def revoke_group(self, user: UserContext) -> ConnectorResult:
        return self._call("revoke_group", user, "POST")
