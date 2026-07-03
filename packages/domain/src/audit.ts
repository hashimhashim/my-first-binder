/**
 * Audit action catalog and log redaction.
 *
 * Every sensitive mutation writes exactly one audit event whose `action`
 * comes from this catalog (working rule 7). Free-form action strings are
 * rejected by the DB CHECK (`^[a-z_]+\.[a-z_]+$`) and by services validating
 * against this list.
 */

export const AUDIT_ACTIONS = [
  // identity lifecycle
  'identity.created',
  'identity.updated',
  'identity.status_changed',
  'identity.joiner_processed',
  'identity.mover_processed',
  'identity.leaver_processed',
  'identity_account.linked',
  'identity_account.status_changed',

  // catalog
  'application.created',
  'application.updated',
  'application.retired',
  'entitlement.created',
  'entitlement.updated',
  'entitlement.deprecated',
  'business_role.created',
  'business_role.updated',
  'business_role.disabled',
  'role_entitlement.added',
  'role_entitlement.removed',
  'assignment_rule.created',
  'assignment_rule.updated',

  // grants
  'grant.created',
  'grant.activated',
  'grant.revocation_requested',
  'grant.revoked',
  'grant.cancelled',
  'grant.expired',
  'policy_exception.created',
  'policy_exception.revoked',

  // requests & approvals
  'access_request.submitted',
  'access_request.approved',
  'access_request.rejected',
  'access_request.cancelled',
  'access_request.provisioned',
  'approval.decided',
  'approval.delegated',
  'approval.escalated',

  // provisioning
  'provisioning_job.queued',
  'provisioning_job.completed',
  'provisioning_job.failed',
  'provisioning_job.manual_confirmed',
  'provisioning_job.cancelled',

  // reviews
  'review_campaign.created',
  'review_campaign.activated',
  'review_campaign.closed',
  'review_campaign.cancelled',
  'review_item.decided',
  'review_item.escalated',

  // policy
  'sod_rule.created',
  'sod_rule.updated',
  'sod_violation.detected',
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export function isAuditAction(value: string): value is AuditAction {
  return (AUDIT_ACTIONS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Redaction (working rule: no secrets in logs or audit payloads)
// ---------------------------------------------------------------------------

const SECRET_KEY_PATTERN =
  /(password|passwd|secret|token|credential|api[_-]?key|private[_-]?key|client[_-]?secret|authorization|cookie|bearer|connection[_-]?string)/i;

export const REDACTED = '[REDACTED]';

/**
 * Deep-copies a JSON-ish value, replacing the value of any key whose name
 * looks secret-shaped. Applied to audit before/after payloads, provisioning
 * job payloads, and structured log fields before persistence.
 */
export function redact<T>(value: T): T {
  return redactValue(value, new WeakSet()) as T;
}

function redactValue(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (seen.has(value)) {
    return REDACTED; // break cycles rather than recurse forever
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, seen));
  }
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value)) {
    out[key] = SECRET_KEY_PATTERN.test(key) ? REDACTED : redactValue(val, seen);
  }
  return out;
}
