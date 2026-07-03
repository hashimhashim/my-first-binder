/**
 * Backend authorization context (working rule 6: authz lives in the backend).
 *
 * Every mutating service function takes an AuthzContext and asserts the
 * required platform permission before touching data. The future HTTP layer
 * only *builds* this context from the validated Entra token — it never makes
 * authorization decisions itself.
 */

import type {ActorType} from '@iam/domain';

export const PERMISSIONS = [
  'identity:read',
  'identity:write',
  'identity:lifecycle',
  'application:read',
  'application:write',
  'catalog:read',
  'entitlement:write',
  'role:write',
  'grant:read',
  'grant:write',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export interface AuthzContext {
  /** Identity performing the action; null only for SYSTEM/CONNECTOR actors. */
  actorIdentityId: string | null;
  actorType: ActorType;
  permissions: ReadonlySet<Permission>;
  /** Ties together all audit events of one logical operation. */
  correlationId: string | null;
  /** IP / user agent / route, recorded in audit events. Never tokens. */
  requestContext: Record<string, unknown>;
}

export class PermissionDeniedError extends Error {
  constructor(public readonly permission: Permission) {
    super(`permission denied: ${permission} is required`);
    this.name = 'PermissionDeniedError';
  }
}

export function assertPermission(ctx: AuthzContext, permission: Permission): void {
  if (!ctx.permissions.has(permission)) {
    throw new PermissionDeniedError(permission);
  }
}

export function userContext(
  actorIdentityId: string,
  permissions: Iterable<Permission>,
  options: {correlationId?: string; requestContext?: Record<string, unknown>} = {},
): AuthzContext {
  return {
    actorIdentityId,
    actorType: 'USER',
    permissions: new Set(permissions),
    correlationId: options.correlationId ?? crypto.randomUUID(),
    requestContext: options.requestContext ?? {},
  };
}

/** Context for platform workers (expiry sweeps, JML processors). */
export function systemContext(correlationId?: string): AuthzContext {
  return {
    actorIdentityId: null,
    actorType: 'SYSTEM',
    permissions: new Set(PERMISSIONS),
    correlationId: correlationId ?? crypto.randomUUID(),
    requestContext: {},
  };
}
