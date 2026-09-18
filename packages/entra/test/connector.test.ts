import type {ConnectorJob} from '@iam/services';
import {describe, expect, it} from 'vitest';
import {EntraGraphConnector} from '../src/connector.js';
import {GraphClient} from '../src/graphClient.js';

type Route = (method: string, path: string, body?: unknown) => {status: number; body?: unknown};

function connectorWith(route: Route): {connector: EntraGraphConnector; calls: string[]} {
  const calls: string[] = [];
  const graph = new GraphClient({
    tokenProvider: {getToken: async () => 't'},
    baseUrl: 'https://graph.test/v1.0',
    fetchImpl: async (url, init) => {
      const path = String(url).replace('https://graph.test/v1.0', '');
      const method = init?.method ?? 'GET';
      calls.push(`${method} ${path}`);
      const result = route(method, path, init?.body ? JSON.parse(String(init.body)) : undefined);
      return new Response(result.body === undefined ? null : JSON.stringify(result.body), {
        status: result.status,
      });
    },
  });
  return {connector: new EntraGraphConnector(graph), calls};
}

function job(jobType: 'GRANT' | 'REVOKE', payload: Record<string, unknown>): ConnectorJob {
  return {id: 'job-1', jobType, applicationId: 'app-1', payload};
}

const GROUP_PAYLOAD = {
  externalRef: {entraGroupObjectId: 'grp-1'},
  accountExternalRef: {objectId: 'usr-1'},
};

describe('group membership', () => {
  it('adds a member when absent', async () => {
    const {connector, calls} = connectorWith((method, path) => {
      if (method === 'GET' && path === '/groups/grp-1/members/usr-1') return {status: 404};
      if (method === 'POST' && path === '/groups/grp-1/members/$ref') return {status: 204};
      return {status: 500};
    });
    expect(await connector.execute(job('GRANT', GROUP_PAYLOAD))).toEqual({ok: true});
    expect(calls).toEqual(['GET /groups/grp-1/members/usr-1', 'POST /groups/grp-1/members/$ref']);
  });

  it('is idempotent: existing membership is success without a write', async () => {
    const {connector, calls} = connectorWith((method, path) => {
      if (method === 'GET' && path === '/groups/grp-1/members/usr-1')
        return {status: 200, body: {id: 'usr-1'}};
      return {status: 500};
    });
    expect(await connector.execute(job('GRANT', GROUP_PAYLOAD))).toEqual({ok: true});
    expect(calls).toEqual(['GET /groups/grp-1/members/usr-1']);
  });

  it('tolerates the add racing another writer ("already exists")', async () => {
    const {connector} = connectorWith((method) =>
      method === 'GET'
        ? {status: 404}
        : {status: 400, body: {error: {message: 'One or more added object references already exist'}}},
    );
    expect(await connector.execute(job('GRANT', GROUP_PAYLOAD))).toEqual({ok: true});
  });

  it('revokes idempotently: 404 on delete is success', async () => {
    const {connector} = connectorWith(() => ({status: 404}));
    expect(await connector.execute(job('REVOKE', GROUP_PAYLOAD))).toEqual({ok: true});
  });

  it('classifies 503 as retryable and 403 as manual-queue material', async () => {
    const {connector: flaky} = connectorWith(() => ({status: 503}));
    expect(await flaky.execute(job('GRANT', GROUP_PAYLOAD))).toMatchObject({
      ok: false,
      retryable: true,
    });
    const {connector: forbidden} = connectorWith(() => ({status: 403}));
    expect(await forbidden.execute(job('REVOKE', GROUP_PAYLOAD))).toMatchObject({
      ok: false,
      retryable: false,
    });
  });
});

describe('app role assignments', () => {
  const APP_ROLE_PAYLOAD = {
    externalRef: {servicePrincipalId: 'sp-1', appRoleId: 'role-1'},
    accountExternalRef: {objectId: 'usr-1'},
  };

  it('assigns when absent and skips when present', async () => {
    let assignments: Array<Record<string, string>> = [];
    const {connector, calls} = connectorWith((method, path, body) => {
      if (method === 'GET' && path === '/users/usr-1/appRoleAssignments')
        return {status: 200, body: {value: assignments}};
      if (method === 'POST' && path === '/users/usr-1/appRoleAssignments') {
        assignments = [{id: 'a-1', resourceId: 'sp-1', appRoleId: String((body as Record<string, unknown>)['appRoleId'])}];
        return {status: 201, body: assignments[0]};
      }
      return {status: 500};
    });
    expect(await connector.execute(job('GRANT', APP_ROLE_PAYLOAD))).toEqual({ok: true});
    expect(await connector.execute(job('GRANT', APP_ROLE_PAYLOAD))).toEqual({ok: true});
    expect(calls.filter((c) => c.startsWith('POST'))).toHaveLength(1);
  });

  it('revokes the matching assignment and treats absence as success', async () => {
    const assignments = [{id: 'a-9', resourceId: 'sp-1', appRoleId: 'role-1'}];
    const {connector, calls} = connectorWith((method, path) => {
      if (method === 'GET') return {status: 200, body: {value: assignments}};
      if (method === 'DELETE' && path === '/users/usr-1/appRoleAssignments/a-9') {
        assignments.length = 0;
        return {status: 204};
      }
      return {status: 500};
    });
    expect(await connector.execute(job('REVOKE', APP_ROLE_PAYLOAD))).toEqual({ok: true});
    expect(await connector.execute(job('REVOKE', APP_ROLE_PAYLOAD))).toEqual({ok: true});
    expect(calls.filter((c) => c.startsWith('DELETE'))).toHaveLength(1);
  });
});

describe('configuration failures route to the manual queue', () => {
  it('rejects jobs for identities without a linked Entra account', async () => {
    const {connector} = connectorWith(() => ({status: 500}));
    const outcome = await connector.execute(
      job('GRANT', {externalRef: {entraGroupObjectId: 'grp-1'}, accountExternalRef: null}),
    );
    expect(outcome).toMatchObject({ok: false, retryable: false});
    expect((outcome as {error: string}).error).toMatch(/linked Entra account/);
  });

  it('rejects entitlements without an Entra binding', async () => {
    const {connector} = connectorWith(() => ({status: 500}));
    expect(
      await connector.execute(job('GRANT', {externalRef: {}, accountExternalRef: {objectId: 'u'}})),
    ).toMatchObject({ok: false, retryable: false});
  });

  it('rejects unsupported job types', async () => {
    const {connector} = connectorWith(() => ({status: 500}));
    const outcome = await connector.execute({
      id: 'j',
      jobType: 'CREATE_ACCOUNT',
      applicationId: 'a',
      payload: {},
    });
    expect(outcome).toMatchObject({ok: false, retryable: false});
  });
});
