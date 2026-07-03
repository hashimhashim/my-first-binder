import {describe, expect, it} from 'vitest';
import {AUDIT_ACTIONS, findSecretShapedKeys, isAuditAction, REDACTED, redact} from '../src/audit.js';

describe('audit action catalog', () => {
  it('all actions match the DB CHECK pattern entity.verb', () => {
    for (const action of AUDIT_ACTIONS) {
      expect(action).toMatch(/^[a-z_]+\.[a-z_]+$/);
    }
  });

  it('validates known and rejects unknown actions', () => {
    expect(isAuditAction('grant.revoked')).toBe(true);
    expect(isAuditAction('grant.deleted_everything')).toBe(false);
    expect(isAuditAction('DROP TABLE')).toBe(false);
  });
});

describe('redaction', () => {
  it('redacts secret-shaped keys at any depth', () => {
    const input = {
      user: 'alice',
      password: 'hunter2',
      nested: {
        clientSecret: 'abc',
        api_key: 'xyz',
        Authorization: 'Bearer token',
        safe: 'keep-me',
      },
      list: [{connection_string: 'Server=...'}, {value: 1}],
    };
    const out = redact(input);
    expect(out.password).toBe(REDACTED);
    expect(out.nested.clientSecret).toBe(REDACTED);
    expect(out.nested.api_key).toBe(REDACTED);
    expect(out.nested.Authorization).toBe(REDACTED);
    expect(out.nested.safe).toBe('keep-me');
    expect(out.list[0]!.connection_string).toBe(REDACTED);
    expect(out.list[1]!.value).toBe(1);
  });

  it('does not mutate the input', () => {
    const input = {token: 'secret-token'};
    redact(input);
    expect(input.token).toBe('secret-token');
  });

  it('finds secret-shaped keys with their paths', () => {
    expect(
      findSecretShapedKeys({
        keyVaultSecretName: 'graph-client', // matches "secret" — rejected by design
        endpoints: [{url: 'https://graph', apiKey: 'x'}],
        tenantId: 'contoso',
      }).sort(),
    ).toEqual(['endpoints[0].apiKey', 'keyVaultSecretName']);
    expect(findSecretShapedKeys({tenantId: 'contoso', keyVaultRef: 'graph-client'})).toEqual([]);
    expect(findSecretShapedKeys(null)).toEqual([]);
  });

  it('handles primitives, null, and cycles', () => {
    expect(redact(null)).toBeNull();
    expect(redact('plain')).toBe('plain');
    const cyclic: Record<string, unknown> = {name: 'a'};
    cyclic.self = cyclic;
    const out = redact(cyclic) as Record<string, unknown>;
    expect(out.name).toBe('a');
    expect(out.self).toBe(REDACTED);
  });
});
