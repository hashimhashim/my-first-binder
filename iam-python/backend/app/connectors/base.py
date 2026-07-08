"""Connector plugin framework.

Every application integration implements `Connector`. The set of operations is
uniform across protocols (REST, LDAP, SCIM, SAML, OAuth, PowerShell, custom),
so one provisioning workflow drives them all. Concrete connectors translate
these operations into protocol-specific calls.

Contract:
  * operations are idempotent (safe to retry);
  * they never raise for expected failures — return ConnectorResult(ok=False,
    retryable=...) instead so the orchestrator can back off or route to the
    manual queue;
  * credentials come from the connector's own config, never from the caller.
"""
from __future__ import annotations

import abc
from dataclasses import dataclass, field
from typing import Any


@dataclass
class ConnectorResult:
    ok: bool
    detail: str = ""
    retryable: bool = False
    data: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def success(cls, detail: str = "ok", **data: Any) -> "ConnectorResult":
        return cls(ok=True, detail=detail, data=data)

    @classmethod
    def failure(cls, detail: str, retryable: bool = False) -> "ConnectorResult":
        return cls(ok=False, detail=detail, retryable=retryable)


@dataclass
class UserContext:
    """Normalised user attributes passed to connectors."""

    employee_id: str
    display_name: str
    email: str
    department: str | None = None
    title: str | None = None
    account_identifier: str | None = None
    group_name: str | None = None
    attributes: dict[str, Any] = field(default_factory=dict)


class Connector(abc.ABC):
    """Base class for all application connectors."""

    #: unique protocol/type key, matched against Application.connector_type
    type: str = "base"
    #: human description of the protocol
    label: str = "Base connector"

    def __init__(self, config: dict[str, Any], credentials: dict[str, Any]):
        self.config = config or {}
        self.credentials = credentials or {}

    # -- capabilities the framework exposes uniformly --------------------------
    @abc.abstractmethod
    def test_connection(self) -> ConnectorResult: ...

    @abc.abstractmethod
    def sync_users(self) -> ConnectorResult: ...

    @abc.abstractmethod
    def create_user(self, user: UserContext) -> ConnectorResult: ...

    @abc.abstractmethod
    def update_user(self, user: UserContext) -> ConnectorResult: ...

    @abc.abstractmethod
    def disable_user(self, user: UserContext) -> ConnectorResult: ...

    @abc.abstractmethod
    def delete_user(self, user: UserContext) -> ConnectorResult: ...

    @abc.abstractmethod
    def assign_group(self, user: UserContext) -> ConnectorResult: ...

    @abc.abstractmethod
    def revoke_group(self, user: UserContext) -> ConnectorResult: ...

    # Optional directory-style operations; default to "not supported".
    def enable_user(self, user: UserContext) -> ConnectorResult:
        return ConnectorResult.failure("enable_user not supported by this connector")

    def reset_password(self, user: UserContext) -> ConnectorResult:
        return ConnectorResult.failure("reset_password not supported by this connector")

    def unlock_user(self, user: UserContext) -> ConnectorResult:
        return ConnectorResult.failure("unlock_user not supported by this connector")

    def move_ou(self, user: UserContext, target_ou: str) -> ConnectorResult:
        return ConnectorResult.failure("move_ou not supported by this connector")
