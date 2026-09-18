/**
 * Transactional audit writer. Called with the SAME client/transaction as the
 * state change it documents, so neither can commit without the other.
 * Payloads pass through the domain redaction filter before persistence.
 */

import {isAuditAction, redact, type AuditAction} from '@iam/domain';
import type pg from 'pg';
import type {AuthzContext} from './context.js';

export interface AuditEventInput {
  action: AuditAction;
  entityType: string;
  entityId?: string | null;
  beforeState?: unknown;
  afterState?: unknown;
}

export async function writeAuditEvent(
  client: pg.ClientBase,
  ctx: AuthzContext,
  input: AuditEventInput,
): Promise<void> {
  // Defense in depth: the type system, this check, and the DB CHECK all
  // enforce the action catalog.
  if (!isAuditAction(input.action)) {
    throw new Error(`unknown audit action: ${String(input.action)}`);
  }
  await client.query(
    `INSERT INTO audit_events
       (actor_identity_id, actor_type, action, entity_type, entity_id,
        correlation_id, request_context, before_state, after_state)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      ctx.actorIdentityId,
      ctx.actorType,
      input.action,
      input.entityType,
      input.entityId ?? null,
      ctx.correlationId,
      JSON.stringify(redact(ctx.requestContext)),
      input.beforeState === undefined ? null : JSON.stringify(redact(input.beforeState)),
      input.afterState === undefined ? null : JSON.stringify(redact(input.afterState)),
    ],
  );
}
