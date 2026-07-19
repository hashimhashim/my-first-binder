"""In-memory directory connector that simulates Active Directory / Entra ID.

Lets the full JML + provisioning pipeline run and be observed end to end
without a live tenant. State is process-global so the dashboard can display
the simulated directory. Swap for a real Graph/LDAP connector in production
(same interface).
"""
from __future__ import annotations

from typing import Any

from .base import Connector, ConnectorResult, UserContext

# Simulated directory state: identifier -> account record.
_DIRECTORY: dict[str, dict[str, Any]] = {}


def directory_snapshot() -> list[dict[str, Any]]:
    return list(_DIRECTORY.values())


def _key(user: UserContext) -> str:
    return user.account_identifier or user.email


class MockDirectoryConnector(Connector):
    type = "MOCK_DIRECTORY"
    label = "Simulated Directory (AD / Entra ID)"

    def test_connection(self) -> ConnectorResult:
        return ConnectorResult.success("simulated directory reachable")

    def sync_users(self) -> ConnectorResult:
        return ConnectorResult.success("synced", count=len(_DIRECTORY))

    def create_user(self, user: UserContext) -> ConnectorResult:
        key = _key(user)
        rec = _DIRECTORY.get(key, {})
        rec.update(
            {
                "identifier": key,
                "display_name": user.display_name,
                "email": user.email,
                "department": user.department,
                "status": "ACTIVE",
                "groups": rec.get("groups", []),
            }
        )
        _DIRECTORY[key] = rec  # idempotent upsert
        return ConnectorResult.success("account created/exists", identifier=key)

    def update_user(self, user: UserContext) -> ConnectorResult:
        key = _key(user)
        if key not in _DIRECTORY:
            return self.create_user(user)
        _DIRECTORY[key].update(
            {"display_name": user.display_name, "department": user.department}
        )
        return ConnectorResult.success("account updated", identifier=key)

    def disable_user(self, user: UserContext) -> ConnectorResult:
        key = _key(user)
        if key in _DIRECTORY:
            _DIRECTORY[key]["status"] = "DISABLED"
        return ConnectorResult.success("account disabled", identifier=key)

    def enable_user(self, user: UserContext) -> ConnectorResult:
        key = _key(user)
        if key in _DIRECTORY:
            _DIRECTORY[key]["status"] = "ACTIVE"
        return ConnectorResult.success("account enabled", identifier=key)

    def delete_user(self, user: UserContext) -> ConnectorResult:
        _DIRECTORY.pop(_key(user), None)
        return ConnectorResult.success("account deleted")

    def assign_group(self, user: UserContext) -> ConnectorResult:
        key = _key(user)
        rec = _DIRECTORY.get(key)
        if rec is None:
            self.create_user(user)
            rec = _DIRECTORY[key]
        if user.group_name and user.group_name not in rec["groups"]:
            rec["groups"].append(user.group_name)
        return ConnectorResult.success("group assigned", group=user.group_name)

    def revoke_group(self, user: UserContext) -> ConnectorResult:
        rec = _DIRECTORY.get(_key(user))
        if rec and user.group_name in rec.get("groups", []):
            rec["groups"].remove(user.group_name)
        return ConnectorResult.success("group revoked", group=user.group_name)

    def reset_password(self, user: UserContext) -> ConnectorResult:
        return ConnectorResult.success("password reset issued")

    def unlock_user(self, user: UserContext) -> ConnectorResult:
        return ConnectorResult.success("account unlocked")

    def move_ou(self, user: UserContext, target_ou: str) -> ConnectorResult:
        rec = _DIRECTORY.get(_key(user))
        if rec is not None:
            rec["ou"] = target_ou
        return ConnectorResult.success("moved OU", ou=target_ou)

    def list_accounts(self, since: str | None = None) -> ConnectorResult:
        # The mock has no real change log, so every pull is a full pull —
        # fine for a simulated tenant; real connectors below honour `since`.
        accounts = [
            {
                "identifier": rec["identifier"],
                "email": rec.get("email"),
                "display_name": rec.get("display_name"),
                "status": rec.get("status", "ACTIVE"),
                "groups": list(rec.get("groups", [])),
                "department": rec.get("department"),
            }
            for rec in _DIRECTORY.values()
        ]
        return ConnectorResult.success("listed", accounts=accounts, cursor=None)
