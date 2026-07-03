/**
 * Microsoft Entra ID (Azure AD) provisioning connector.
 *
 * Implements the @iam/services Connector SDK for two entitlement bindings,
 * chosen by the entitlement's external_ref:
 *
 *   {entraGroupObjectId}              -> security-group membership
 *   {servicePrincipalId, appRoleId}   -> app role assignment
 *
 * The target user comes from the job payload's accountExternalRef.objectId
 * (the identity's linked Entra account). Idempotent by construction:
 * grants check membership before adding and tolerate "already exists";
 * revokes tolerate "not found" — so retries and duplicate dispatch converge.
 *
 * Failure classification: 429 and 5xx are retryable (the orchestrator backs
 * off); everything else (403 consent missing, 404 group deleted, 400 bad
 * binding) routes to the manual queue for a human to fix the configuration.
 */

import type {Connector, ConnectorJob, ConnectorOutcome} from '@iam/services';
import type {GraphClient} from './graphClient.js';

export interface EntraEntitlementRef {
  entraGroupObjectId?: string;
  servicePrincipalId?: string;
  appRoleId?: string;
}

function failure(status: number, context: string): ConnectorOutcome {
  return {
    ok: false,
    error: `${context}: Graph responded ${status}`,
    retryable: status === 429 || status >= 500,
  };
}

function config(error: string): ConnectorOutcome {
  return {ok: false, error, retryable: false};
}

export class EntraGraphConnector implements Connector {
  readonly type = 'ENTRA_GRAPH' as const;

  constructor(private readonly graph: GraphClient) {}

  async execute(job: ConnectorJob): Promise<ConnectorOutcome> {
    if (job.jobType !== 'GRANT' && job.jobType !== 'REVOKE') {
      return config(`unsupported job type ${job.jobType} for the Entra connector`);
    }
    const account = job.payload['accountExternalRef'] as {objectId?: unknown} | null | undefined;
    const userObjectId = typeof account?.objectId === 'string' ? account.objectId : null;
    if (userObjectId === null) {
      return config(
        'identity has no linked Entra account (accountExternalRef.objectId missing) — link the account, then retry',
      );
    }
    const ref = (job.payload['externalRef'] ?? {}) as EntraEntitlementRef;
    if (typeof ref.entraGroupObjectId === 'string') {
      return this.groupMembership(job.jobType, ref.entraGroupObjectId, userObjectId);
    }
    if (typeof ref.servicePrincipalId === 'string' && typeof ref.appRoleId === 'string') {
      return this.appRoleAssignment(job.jobType, ref.servicePrincipalId, ref.appRoleId, userObjectId);
    }
    return config('entitlement has no Entra binding (external_ref needs entraGroupObjectId or servicePrincipalId+appRoleId)');
  }

  private async groupMembership(
    jobType: 'GRANT' | 'REVOKE',
    groupId: string,
    userId: string,
  ): Promise<ConnectorOutcome> {
    if (jobType === 'GRANT') {
      const existing = await this.graph.request('GET', `/groups/${groupId}/members/${userId}`);
      if (existing.status === 200) {
        return {ok: true}; // already a member — idempotent success
      }
      if (existing.status !== 404) {
        return failure(existing.status, `check membership of group ${groupId}`);
      }
      const added = await this.graph.request('POST', `/groups/${groupId}/members/$ref`, {
        '@odata.id': `https://graph.microsoft.com/v1.0/directoryObjects/${userId}`,
      });
      if (added.status === 204 || alreadyExists(added)) {
        return {ok: true};
      }
      return failure(added.status, `add member to group ${groupId}`);
    }

    const removed = await this.graph.request('DELETE', `/groups/${groupId}/members/${userId}/$ref`);
    if (removed.status === 204 || removed.status === 404) {
      return {ok: true}; // gone (or never there) — idempotent success
    }
    return failure(removed.status, `remove member from group ${groupId}`);
  }

  private async appRoleAssignment(
    jobType: 'GRANT' | 'REVOKE',
    servicePrincipalId: string,
    appRoleId: string,
    userId: string,
  ): Promise<ConnectorOutcome> {
    const list = await this.graph.request('GET', `/users/${userId}/appRoleAssignments`);
    if (list.status !== 200) {
      return failure(list.status, `list app role assignments for ${userId}`);
    }
    const assignments = ((list.body as {value?: unknown[]})?.value ?? []) as Array<
      Record<string, unknown>
    >;
    const match = assignments.find(
      (a) => a['resourceId'] === servicePrincipalId && a['appRoleId'] === appRoleId,
    );

    if (jobType === 'GRANT') {
      if (match !== undefined) {
        return {ok: true};
      }
      const created = await this.graph.request('POST', `/users/${userId}/appRoleAssignments`, {
        principalId: userId,
        resourceId: servicePrincipalId,
        appRoleId,
      });
      if (created.status === 201 || alreadyExists(created)) {
        return {ok: true};
      }
      return failure(created.status, `assign app role ${appRoleId}`);
    }

    if (match === undefined) {
      return {ok: true};
    }
    const deleted = await this.graph.request(
      'DELETE',
      `/users/${userId}/appRoleAssignments/${String(match['id'])}`,
    );
    if (deleted.status === 204 || deleted.status === 404) {
      return {ok: true};
    }
    return failure(deleted.status, `remove app role ${appRoleId}`);
  }
}

function alreadyExists(response: {status: number; body: unknown}): boolean {
  if (response.status !== 400) {
    return false;
  }
  const message = (response.body as {error?: {message?: string}})?.error?.message ?? '';
  return /already exist/i.test(message);
}
