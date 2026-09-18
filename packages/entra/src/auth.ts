/**
 * OIDC groundwork: validation of Microsoft Entra ID access tokens and the
 * mapping from Entra app roles to platform permissions.
 *
 * The HTTP layer (API phase) verifies the bearer token here, resolves the
 * caller's identity row from the oid claim, and builds the AuthzContext —
 * authorization decisions stay in the backend services (working rule 6).
 */

import type {Permission} from '@iam/services';
import {PERMISSIONS} from '@iam/services';
import {createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey} from 'jose';

export interface EntraPrincipal {
  /** Entra object id (oid claim) — joins to identity_accounts.external_ref. */
  objectId: string;
  upn: string | null;
  name: string | null;
  /** App roles from the token's roles claim (defined on the app registration). */
  appRoles: string[];
}

export interface EntraVerifierOptions {
  tenantId: string;
  /** Expected audience: the API's application (client) ID URI. */
  audience: string;
  /** Injectable for tests; defaults to the tenant's remote JWKS. */
  getKey?: JWTVerifyGetKey;
}

export class EntraTokenVerifier {
  private readonly getKey: JWTVerifyGetKey;
  private readonly issuer: string;

  constructor(private readonly options: EntraVerifierOptions) {
    this.issuer = `https://login.microsoftonline.com/${options.tenantId}/v2.0`;
    this.getKey =
      options.getKey ??
      createRemoteJWKSet(
        new URL(`https://login.microsoftonline.com/${options.tenantId}/discovery/v2.0/keys`),
      );
  }

  async verify(token: string): Promise<EntraPrincipal> {
    const {payload} = await jwtVerify(token, this.getKey, {
      issuer: this.issuer,
      audience: this.options.audience,
    });
    const oid = payload['oid'];
    if (typeof oid !== 'string' || oid.length === 0) {
      throw new Error('token has no oid claim');
    }
    const roles = Array.isArray(payload['roles'])
      ? payload['roles'].filter((r): r is string => typeof r === 'string')
      : [];
    return {
      objectId: oid,
      upn: typeof payload['preferred_username'] === 'string' ? payload['preferred_username'] : null,
      name: typeof payload['name'] === 'string' ? payload['name'] : null,
      appRoles: roles,
    };
  }
}

/**
 * Default app-role -> platform-permission map. App roles are defined on the
 * Entra app registration and arrive in the token's roles claim; unknown
 * roles grant nothing (fail closed).
 */
export const DEFAULT_APP_ROLE_PERMISSIONS: Readonly<Record<string, readonly Permission[]>> = {
  'IAM.Admin': PERMISSIONS,
  'IAM.User': ['identity:read', 'catalog:read', 'request:read', 'request:submit'],
  'IAM.Approver': ['catalog:read', 'request:read', 'request:approve'],
  'IAM.Fulfiller': ['provisioning:read', 'provisioning:confirm'],
  'IAM.Auditor': [
    'identity:read',
    'application:read',
    'catalog:read',
    'grant:read',
    'request:read',
    'provisioning:read',
  ],
};

export function permissionsForAppRoles(
  appRoles: readonly string[],
  roleMap: Readonly<Record<string, readonly Permission[]>> = DEFAULT_APP_ROLE_PERMISSIONS,
): Set<Permission> {
  const permissions = new Set<Permission>();
  for (const role of appRoles) {
    for (const permission of roleMap[role] ?? []) {
      permissions.add(permission);
    }
  }
  return permissions;
}
