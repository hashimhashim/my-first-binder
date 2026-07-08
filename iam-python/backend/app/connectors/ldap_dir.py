"""LDAP / LDAPS / Active Directory connector (reference implementation).

Translates the uniform operations into LDAP directory operations. To keep the
module import-light and runnable without an LDAP server present, the python
`ldap3` calls are guarded: if the library or a live server is unavailable, the
connector reports a clear, non-crashing result. In production, install
`ldap3` and point `config.server_uri` at your DC (ldaps://...).

config: {"server_uri": "ldaps://dc.corp.local", "base_dn": "OU=Users,DC=corp,DC=local"}
credentials: {"bind_dn": "...", "password": "..."}
"""
from __future__ import annotations

from .base import Connector, ConnectorResult, UserContext


class LdapConnector(Connector):
    type = "LDAP"
    label = "LDAP / LDAPS / Active Directory"

    def _connect(self):
        try:
            import ldap3  # type: ignore
        except ImportError:
            return None, ConnectorResult.failure(
                "ldap3 not installed — add it to requirements and configure server_uri",
            )
        server_uri = self.config.get("server_uri")
        if not server_uri:
            return None, ConnectorResult.failure("no server_uri configured")
        try:
            server = ldap3.Server(server_uri, use_ssl=server_uri.startswith("ldaps"))
            conn = ldap3.Connection(
                server,
                user=self.credentials.get("bind_dn"),
                password=self.credentials.get("password"),
                auto_bind=True,
            )
            return conn, None
        except Exception as exc:  # noqa: BLE001 — surface as retryable transport error
            return None, ConnectorResult.failure(f"bind failed: {exc}", retryable=True)

    def _dn(self, user: UserContext) -> str:
        base = self.config.get("base_dn", "")
        return f"CN={user.display_name},{base}"

    def test_connection(self) -> ConnectorResult:
        conn, err = self._connect()
        if err:
            return err
        conn.unbind()
        return ConnectorResult.success("bind ok")

    def sync_users(self) -> ConnectorResult:
        conn, err = self._connect()
        if err:
            return err
        conn.search(self.config.get("base_dn", ""), "(objectClass=user)", attributes=["cn", "mail"])
        n = len(conn.entries)
        conn.unbind()
        return ConnectorResult.success("synced", count=n)

    def create_user(self, user: UserContext) -> ConnectorResult:
        conn, err = self._connect()
        if err:
            return err
        ok = conn.add(
            self._dn(user),
            ["top", "person", "organizationalPerson", "user"],
            {"sAMAccountName": user.email.split("@")[0], "mail": user.email, "displayName": user.display_name},
        )
        detail = "created" if ok else str(conn.result)
        conn.unbind()
        return ConnectorResult.success(detail) if ok else ConnectorResult.failure(detail)

    def _modify(self, user: UserContext, changes: dict) -> ConnectorResult:
        conn, err = self._connect()
        if err:
            return err
        ok = conn.modify(self._dn(user), changes)
        res = conn.result
        conn.unbind()
        return ConnectorResult.success("modified") if ok else ConnectorResult.failure(str(res))

    def update_user(self, user: UserContext) -> ConnectorResult:
        import ldap3  # type: ignore
        return self._modify(user, {"displayName": [(ldap3.MODIFY_REPLACE, [user.display_name])]})

    def disable_user(self, user: UserContext) -> ConnectorResult:
        # AD: set userAccountControl bit 2 (ACCOUNTDISABLE).
        import ldap3  # type: ignore
        return self._modify(user, {"userAccountControl": [(ldap3.MODIFY_REPLACE, [514])]})

    def enable_user(self, user: UserContext) -> ConnectorResult:
        import ldap3  # type: ignore
        return self._modify(user, {"userAccountControl": [(ldap3.MODIFY_REPLACE, [512])]})

    def delete_user(self, user: UserContext) -> ConnectorResult:
        conn, err = self._connect()
        if err:
            return err
        ok = conn.delete(self._dn(user))
        conn.unbind()
        return ConnectorResult.success("deleted") if ok else ConnectorResult.failure(str(conn.result))

    def assign_group(self, user: UserContext) -> ConnectorResult:
        import ldap3  # type: ignore
        group_dn = f"CN={user.group_name},{self.config.get('base_dn', '')}"
        conn, err = self._connect()
        if err:
            return err
        ok = conn.modify(group_dn, {"member": [(ldap3.MODIFY_ADD, [self._dn(user)])]})
        conn.unbind()
        return ConnectorResult.success("group assigned") if ok else ConnectorResult.failure(str(conn.result))

    def revoke_group(self, user: UserContext) -> ConnectorResult:
        import ldap3  # type: ignore
        group_dn = f"CN={user.group_name},{self.config.get('base_dn', '')}"
        conn, err = self._connect()
        if err:
            return err
        ok = conn.modify(group_dn, {"member": [(ldap3.MODIFY_DELETE, [self._dn(user)])]})
        conn.unbind()
        return ConnectorResult.success("group revoked") if ok else ConnectorResult.failure(str(conn.result))
