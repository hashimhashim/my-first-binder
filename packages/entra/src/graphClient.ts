/**
 * Minimal Microsoft Graph REST client with OAuth2 client-credentials token
 * acquisition. Dependency-light and fully testable: fetch is injectable and
 * the client secret comes from a SecretProvider (Key Vault in production),
 * held only in memory for the duration of the token request.
 */

import type {SecretProvider, TokenProvider} from './secrets.js';

export interface ClientCredentialsOptions {
  tenantId: string;
  clientId: string;
  /** Reference resolved via the SecretProvider — never the secret itself. */
  clientSecretRef: string;
  secrets: SecretProvider;
  scope?: string;
  authorityBase?: string;
  fetchImpl?: typeof fetch;
}

export class ClientCredentialsTokenProvider implements TokenProvider {
  private cached: {token: string; expiresAt: number} | null = null;

  constructor(private readonly options: ClientCredentialsOptions) {}

  async getToken(): Promise<string> {
    const now = Date.now();
    if (this.cached !== null && this.cached.expiresAt - 60_000 > now) {
      return this.cached.token;
    }
    const doFetch = this.options.fetchImpl ?? fetch;
    const authority = this.options.authorityBase ?? 'https://login.microsoftonline.com';
    const clientSecret = await this.options.secrets.getSecret(this.options.clientSecretRef);
    const response = await doFetch(`${authority}/${this.options.tenantId}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: {'Content-Type': 'application/x-www-form-urlencoded'},
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: this.options.clientId,
        client_secret: clientSecret,
        scope: this.options.scope ?? 'https://graph.microsoft.com/.default',
      }).toString(),
    });
    if (!response.ok) {
      throw new Error(`token endpoint returned ${response.status}`);
    }
    const body = (await response.json()) as {access_token?: string; expires_in?: number};
    if (typeof body.access_token !== 'string') {
      throw new Error('token endpoint returned no access_token');
    }
    this.cached = {
      token: body.access_token,
      expiresAt: now + (body.expires_in ?? 3600) * 1000,
    };
    return this.cached.token;
  }
}

export interface GraphResponse {
  status: number;
  body: unknown;
}

export class GraphClient {
  constructor(
    private readonly options: {
      tokenProvider: TokenProvider;
      baseUrl?: string;
      fetchImpl?: typeof fetch;
    },
  ) {}

  /** Issues a Graph call; returns status + parsed body, never throws on HTTP errors. */
  async request(method: string, path: string, body?: unknown): Promise<GraphResponse> {
    const doFetch = this.options.fetchImpl ?? fetch;
    const baseUrl = this.options.baseUrl ?? 'https://graph.microsoft.com/v1.0';
    const token = await this.options.tokenProvider.getToken();
    const response = await doFetch(`${baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body !== undefined ? {'Content-Type': 'application/json'} : {}),
      },
      ...(body !== undefined ? {body: JSON.stringify(body)} : {}),
    });
    let parsed: unknown = null;
    const text = await response.text();
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    return {status: response.status, body: parsed};
  }
}
