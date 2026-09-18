/**
 * Request authentication -> AuthzContext.
 *
 * Production mode (ENTRA_TENANT_ID + ENTRA_AUDIENCE set): validates the
 * Authorization bearer token against Entra ID, resolves the caller's
 * identity row from the token's oid (via identity_accounts.external_ref)
 * or email, and maps token app roles to platform permissions.
 *
 * Dev mode (no Entra config): the caller picks a persona with
 * x-dev-actor (email) and x-dev-roles (comma-separated Entra-style app
 * roles). Same fail-closed role->permission mapping as production.
 *
 * Either way, the HTTP layer only BUILDS the context; every authorization
 * decision happens inside @iam/services (working rule 6).
 */

import {permissionsForAppRoles, type EntraTokenVerifier} from '@iam/entra';
import {userContext, type AuthzContext} from '@iam/services';
import type {FastifyRequest} from 'fastify';
import type pg from 'pg';

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

export interface AuthenticatedRequest {
  ctx: AuthzContext;
  identity: {id: string; displayName: string; email: string | null};
  appRoles: string[];
}

export interface AuthOptions {
  pool: pg.Pool;
  verifier: EntraTokenVerifier | null;
}

export async function authenticate(
  request: FastifyRequest,
  options: AuthOptions,
): Promise<AuthenticatedRequest> {
  const requestContext = {
    ip: request.ip,
    route: `${request.method} ${request.url.split('?')[0]}`,
  };

  if (options.verifier !== null) {
    const header = request.headers.authorization ?? '';
    if (!header.startsWith('Bearer ')) {
      throw new AuthError('missing bearer token');
    }
    const principal = await options.verifier.verify(header.slice(7));
    const byAccount = await options.pool.query(
      `SELECT i.id, i.display_name, i.primary_email FROM identities i
       JOIN identity_accounts ia ON ia.identity_id = i.id
       WHERE ia.external_ref->>'objectId' = $1
       UNION
       SELECT id, display_name, primary_email FROM identities WHERE lower(primary_email) = lower($2)
       LIMIT 1`,
      [principal.objectId, principal.upn ?? ''],
    );
    if (byAccount.rows.length === 0) {
      throw new AuthError('token is valid but no identity is linked to this account');
    }
    const row = byAccount.rows[0] as {id: string; display_name: string; primary_email: string | null};
    return {
      ctx: userContext(row.id, permissionsForAppRoles(principal.appRoles), {requestContext}),
      identity: {id: row.id, displayName: row.display_name, email: row.primary_email},
      appRoles: principal.appRoles,
    };
  }

  // Dev mode
  const email = String(request.headers['x-dev-actor'] ?? '');
  if (email === '') {
    throw new AuthError('dev mode: set the x-dev-actor header to a persona email');
  }
  const roles = String(request.headers['x-dev-roles'] ?? 'IAM.User')
    .split(',')
    .map((r) => r.trim())
    .filter((r) => r.length > 0);
  const {rows} = await options.pool.query(
    'SELECT id, display_name, primary_email FROM identities WHERE lower(primary_email) = lower($1)',
    [email],
  );
  if (rows.length === 0) {
    throw new AuthError(`dev mode: no identity with email ${email}`);
  }
  const row = rows[0] as {id: string; display_name: string; primary_email: string | null};
  return {
    ctx: userContext(row.id, permissionsForAppRoles(roles), {requestContext}),
    identity: {id: row.id, displayName: row.display_name, email: row.primary_email},
    appRoles: roles,
  };
}
