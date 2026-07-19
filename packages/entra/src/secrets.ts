/**
 * Secret resolution. The platform never stores secrets — applications and
 * connectors hold *references* (a Key Vault secret name, an env var name),
 * resolved at use time and kept only in memory.
 */

export interface SecretProvider {
  getSecret(ref: string): Promise<string>;
}

/** Development/test provider: the reference is an environment variable name. */
export class EnvSecretProvider implements SecretProvider {
  async getSecret(ref: string): Promise<string> {
    const value = process.env[ref];
    if (value === undefined || value === '') {
      throw new Error(`secret reference ${ref} is not set in the environment`);
    }
    return value;
  }
}

export interface TokenProvider {
  getToken(): Promise<string>;
}

/**
 * Azure Key Vault provider (REST, api-version 7.4). Authenticates with a
 * token for https://vault.azure.net/.default — client credentials here,
 * managed identity when hosted in Azure.
 */
export class KeyVaultSecretProvider implements SecretProvider {
  constructor(
    private readonly options: {
      /** e.g. https://my-vault.vault.azure.net */
      vaultUrl: string;
      tokenProvider: TokenProvider;
      fetchImpl?: typeof fetch;
    },
  ) {}

  async getSecret(ref: string): Promise<string> {
    const doFetch = this.options.fetchImpl ?? fetch;
    const token = await this.options.tokenProvider.getToken();
    const response = await doFetch(
      `${this.options.vaultUrl}/secrets/${encodeURIComponent(ref)}?api-version=7.4`,
      {headers: {Authorization: `Bearer ${token}`}},
    );
    if (!response.ok) {
      // Never echo response bodies here — they can carry secret material.
      throw new Error(`Key Vault returned ${response.status} for secret ${ref}`);
    }
    const body = (await response.json()) as {value?: string};
    if (typeof body.value !== 'string') {
      throw new Error(`Key Vault secret ${ref} has no value`);
    }
    return body.value;
  }
}
