/**
 * Connector SDK.
 *
 * A connector translates a provisioning job into calls against a target
 * system (Microsoft Graph, an app API, ...). Contract:
 *
 *  - execute() MUST be idempotent: jobs are retried, and a retry after a
 *    half-completed attempt must converge (check-then-act against the
 *    target, or use natively idempotent target APIs).
 *  - execute() MUST NOT throw for expected failures — return {ok: false}
 *    with retryable set, so the orchestrator can back off or route the job
 *    to the manual queue. Thrown errors are treated as retryable failures.
 *  - Payloads and error strings must never contain secrets; credentials
 *    come from the connector's own configuration (Key Vault), never from
 *    the job.
 *
 * MANUAL is not a connector: the orchestrator routes those jobs to the
 * manual fulfillment queue where a human confirms completion.
 */

import type {ConnectorType, ProvisioningJobType} from '@iam/domain';

export interface ConnectorJob {
  id: string;
  jobType: ProvisioningJobType;
  applicationId: string;
  payload: Record<string, unknown>;
}

export type ConnectorOutcome =
  | {ok: true}
  | {ok: false; error: string; retryable: boolean};

export interface Connector {
  readonly type: Exclude<ConnectorType, 'MANUAL'>;
  execute(job: ConnectorJob): Promise<ConnectorOutcome>;
}

export class ConnectorRegistry {
  private readonly connectors = new Map<ConnectorType, Connector>();

  register(connector: Connector): this {
    this.connectors.set(connector.type, connector);
    return this;
  }

  get(type: ConnectorType): Connector | undefined {
    return this.connectors.get(type);
  }
}
