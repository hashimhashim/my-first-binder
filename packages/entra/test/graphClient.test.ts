import {describe, expect, it} from 'vitest';
import {ClientCredentialsTokenProvider, GraphClient} from '../src/graphClient.js';
import {EnvSecretProvider, KeyVaultSecretProvider} from '../src/secrets.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {'Content-Type': 'application/json'},
  });
}

describe('ClientCredentialsTokenProvider', () => {
  it('fetches a token with the secret from the provider and caches it', async () => {
    process.env['TEST_CLIENT_SECRET'] = 's3cret-value';
    const calls: Array<{url: string; body: string}> = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      calls.push({url: String(url), body: String(init?.body)});
      return jsonResponse(200, {access_token: 'tok-1', expires_in: 3600});
    };
    const provider = new ClientCredentialsTokenProvider({
      tenantId: 'contoso-tenant',
      clientId: 'client-123',
      clientSecretRef: 'TEST_CLIENT_SECRET',
      secrets: new EnvSecretProvider(),
      fetchImpl,
    });

    expect(await provider.getToken()).toBe('tok-1');
    expect(await provider.getToken()).toBe('tok-1'); // cached
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://login.microsoftonline.com/contoso-tenant/oauth2/v2.0/token');
    const params = new URLSearchParams(calls[0]!.body);
    expect(params.get('grant_type')).toBe('client_credentials');
    expect(params.get('client_secret')).toBe('s3cret-value');
    expect(params.get('scope')).toBe('https://graph.microsoft.com/.default');
  });

  it('refuses to start without the secret being resolvable', async () => {
    const provider = new ClientCredentialsTokenProvider({
      tenantId: 't',
      clientId: 'c',
      clientSecretRef: 'MISSING_SECRET_REF',
      secrets: new EnvSecretProvider(),
      fetchImpl: async () => jsonResponse(200, {}),
    });
    await expect(provider.getToken()).rejects.toThrowError(/MISSING_SECRET_REF/);
  });
});

describe('KeyVaultSecretProvider', () => {
  it('resolves secrets via the vault REST API without leaking bodies on error', async () => {
    const provider = new KeyVaultSecretProvider({
      vaultUrl: 'https://vault.example.net',
      tokenProvider: {getToken: async () => 'vault-token'},
      fetchImpl: async (url, init) => {
        expect(String(url)).toBe('https://vault.example.net/secrets/graph-client?api-version=7.4');
        expect((init?.headers as Record<string, string>)['Authorization']).toBe('Bearer vault-token');
        return jsonResponse(200, {value: 'from-vault'});
      },
    });
    expect(await provider.getSecret('graph-client')).toBe('from-vault');

    const failing = new KeyVaultSecretProvider({
      vaultUrl: 'https://vault.example.net',
      tokenProvider: {getToken: async () => 'vault-token'},
      fetchImpl: async () => jsonResponse(403, {error: 'secret-material-here'}),
    });
    await expect(failing.getSecret('graph-client')).rejects.toThrowError(/403/);
    await expect(failing.getSecret('graph-client')).rejects.not.toThrowError(/secret-material/);
  });
});

describe('GraphClient', () => {
  it('sends bearer-authenticated JSON requests and parses responses', async () => {
    const client = new GraphClient({
      tokenProvider: {getToken: async () => 'graph-token'},
      baseUrl: 'https://graph.test/v1.0',
      fetchImpl: async (url, init) => {
        expect(String(url)).toBe('https://graph.test/v1.0/groups/g1/members/$ref');
        expect((init?.headers as Record<string, string>)['Authorization']).toBe('Bearer graph-token');
        expect(JSON.parse(String(init?.body))['@odata.id']).toContain('directoryObjects/u1');
        return new Response(null, {status: 204});
      },
    });
    const response = await client.request('POST', '/groups/g1/members/$ref', {
      '@odata.id': 'https://graph.microsoft.com/v1.0/directoryObjects/u1',
    });
    expect(response).toEqual({status: 204, body: null});
  });
});
