import {generateKeyPair, SignJWT} from 'jose';
import {describe, expect, it} from 'vitest';
import {EntraTokenVerifier, permissionsForAppRoles} from '../src/auth.js';

const TENANT = 'contoso-tenant';
const AUDIENCE = 'api://iam-platform';

async function makeVerifierAndSigner() {
  const {publicKey, privateKey} = await generateKeyPair('RS256');
  const verifier = new EntraTokenVerifier({
    tenantId: TENANT,
    audience: AUDIENCE,
    getKey: async () => publicKey,
  });
  const sign = (claims: Record<string, unknown>, overrides: {aud?: string; iss?: string} = {}) =>
    new SignJWT(claims)
      .setProtectedHeader({alg: 'RS256'})
      .setIssuer(overrides.iss ?? `https://login.microsoftonline.com/${TENANT}/v2.0`)
      .setAudience(overrides.aud ?? AUDIENCE)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);
  return {verifier, sign};
}

describe('EntraTokenVerifier', () => {
  it('accepts a valid token and extracts the principal', async () => {
    const {verifier, sign} = await makeVerifierAndSigner();
    const token = await sign({
      oid: '00000000-aaaa-bbbb-cccc-000000000001',
      preferred_username: 'alice@corp.example.com',
      name: 'Alice Smith',
      roles: ['IAM.User', 'IAM.Approver'],
    });
    const principal = await verifier.verify(token);
    expect(principal).toEqual({
      objectId: '00000000-aaaa-bbbb-cccc-000000000001',
      upn: 'alice@corp.example.com',
      name: 'Alice Smith',
      appRoles: ['IAM.User', 'IAM.Approver'],
    });
  });

  it('rejects wrong audience, wrong issuer, and missing oid', async () => {
    const {verifier, sign} = await makeVerifierAndSigner();
    await expect(
      verifier.verify(await sign({oid: 'x'}, {aud: 'api://someone-else'})),
    ).rejects.toThrow();
    await expect(
      verifier.verify(await sign({oid: 'x'}, {iss: 'https://evil.example.com'})),
    ).rejects.toThrow();
    await expect(verifier.verify(await sign({name: 'No Oid'}))).rejects.toThrowError(/oid/);
  });
});

describe('app role -> permission mapping', () => {
  it('unions role permissions and fails closed on unknown roles', () => {
    const permissions = permissionsForAppRoles(['IAM.User', 'IAM.Fulfiller', 'Not.A.Role']);
    expect(permissions.has('request:submit')).toBe(true);
    expect(permissions.has('provisioning:confirm')).toBe(true);
    expect(permissions.has('role:write')).toBe(false);
    expect(permissionsForAppRoles(['Unknown']).size).toBe(0);
    expect(permissionsForAppRoles([]).size).toBe(0);
  });

  it('grants admins everything', () => {
    expect(permissionsForAppRoles(['IAM.Admin']).has('grant:write')).toBe(true);
  });
});
