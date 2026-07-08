"""Connector registry — the scalable plugin system.

New integrations register a Connector subclass here (or via entry points in a
real deployment). Applications reference a connector by its `type` string, so
adding support for a new system is a single class + one register() call.
"""
from __future__ import annotations

from typing import Any

from .base import Connector
from .ldap_dir import LdapConnector
from .mock_directory import MockDirectoryConnector
from .rest import RestConnector
from .scim import ScimConnector

_REGISTRY: dict[str, type[Connector]] = {}


def register(cls: type[Connector]) -> type[Connector]:
    _REGISTRY[cls.type] = cls
    return cls


for _cls in (MockDirectoryConnector, RestConnector, ScimConnector, LdapConnector):
    register(_cls)


def available_types() -> list[dict[str, str]]:
    return [{"type": c.type, "label": c.label} for c in _REGISTRY.values()]


def build(connector_type: str, config: dict[str, Any], credentials: dict[str, Any]) -> Connector:
    if connector_type not in _REGISTRY:
        raise KeyError(f"unknown connector type: {connector_type}")
    return _REGISTRY[connector_type](config, credentials)
