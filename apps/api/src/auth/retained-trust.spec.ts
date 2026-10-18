import { describe, expect, it, jest } from '@jest/globals';
import { generateKeyPairSync } from 'node:crypto';
import { ServiceUnavailableException } from '@nestjs/common';
import { canonicalizeCoreRetainedJson } from '@capiro/shared/core-retained-jcs';
import {
  CORE_RETAINED_TRUST_ENV,
  CoreRetainedTrustConfigError,
  readCoreRetainedTrust,
} from '@capiro/shared/core-retained-trust';
import { createCoreRetainedPrincipalCryptographicVerifier } from '@capiro/shared/core-retained-principal';
import {
  CORE_RETAINED_AUTHORITY_PROBE_OPERATION,
  CORE_RETAINED_AUTHORITY_PROBE_RECIPIENT_PATH,
  createCoreRetainedAuthorityProbeSigner,
} from '@capiro/shared/core-retained-authority-probe';
import { CORE_RETAINED_FLORIDA_DATA_PATH } from '@capiro/shared/core-retained-authority-http';
import { DATA_PATHS } from './retained-principal.service.js';
import {
  createRetainedFloridaAuthorityPort,
  createRetainedFloridaProbeVerifier,
  createRetainedPrincipalPorts,
  retainedTrustFromConfig,
} from './retained-trust.js';

const pemPair = () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privatePem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    publicPem: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
  };
};
const principalKeys = pemPair();
const probeKeys = pemPair();
const N = CORE_RETAINED_TRUST_ENV;
const common = {
  [N.enabled]: 'true',
  [N.issuer]: 'capiro-core-retained',
  [N.coreOrigin]: 'https://core.example.invalid',
  [N.intelOrigin]: 'https://intel.example.invalid',
  [N.principalKeyId]: 'retained-principal-1',
  [N.probeKeyId]: 'retained-probe-1',
};
const coreEnv = { ...common, [N.principalPrivateKey]: principalKeys.privatePem, [N.probePrivateKey]: probeKeys.privatePem };
const intelEnv = { ...common, [N.principalPublicKey]: principalKeys.publicPem, [N.probePublicKey]: probeKeys.publicPem };

const nowMs = 1_800_000_000_000;
const facts = {
  principal: { tenantId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', actorId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', clerkUserId: 'user_current' },
  identityRevision: '1'.repeat(64), resourceRevision: '2'.repeat(64),
  rawRequestSha256: '3'.repeat(64), normalizedArgsSha256: '4'.repeat(64), normalizationContextSha256: '5'.repeat(64),
  currentAuthority: '{"schemaVersion":1,"observation":"synthetic-only"}',
  issuedAtMs: nowMs, originalExpiresAtMs: nowMs + 30_000,
};
const expectedDigests = {
  rawRequestSha256: facts.rawRequestSha256, normalizedArgsSha256: facts.normalizedArgsSha256,
  normalizationContextSha256: facts.normalizationContextSha256,
};
const decode = (header: string) =>
  JSON.parse(Buffer.from(header.slice(header.indexOf(' ') + 1), 'base64url').toString('utf8'));

describe('retained trust loader', () => {
  it.each([{}, { [N.enabled]: '' }, { [N.enabled]: 'false' }])('is inert when disabled: %j', (env) => {
    expect(readCoreRetainedTrust(env, 'core')).toBeNull();
    expect(createRetainedPrincipalPorts(null)).toBeNull();
    expect(createRetainedFloridaProbeVerifier(null)).toBeNull();
  });

  it('keeps the Florida authority port at 503 without trust', async () => {
    await expect(createRetainedFloridaAuthorityPort(null).read({} as never)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('reads the same pins through ConfigService', () => {
    const config = { get: (key: string) => (coreEnv as Record<string, string>)[key] };
    expect(retainedTrustFromConfig(config as never)).toMatchObject({ issuer: common[N.issuer], coreOrigin: common[N.coreOrigin] });
  });

  it.each(Object.keys(coreEnv).filter((key) => key !== N.enabled))('fails startup when enabled without %s, naming only the variable', (missing) => {
    const env: Record<string, string> = { ...coreEnv };
    delete env[missing];
    let error: unknown;
    try { readCoreRetainedTrust(env, 'core'); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(CoreRetainedTrustConfigError);
    expect((error as CoreRetainedTrustConfigError).variable).toBe(missing);
    expect((error as Error).message).not.toContain('PRIVATE KEY');
  });

  it.each(['yes', 'TRUE', '1'])('rejects an ambiguous enable value %s', (enabled) => {
    expect(() => readCoreRetainedTrust({ ...coreEnv, [N.enabled]: enabled }, 'core')).toThrow(CoreRetainedTrustConfigError);
  });

  it.each(['http://core.example.invalid', 'https://core.example.invalid/', 'https://core.example.invalid/api',
    'https://u:p@core.example.invalid', 'https://CORE.example.invalid', 'https://core.example.invalid:443', 'not a url'])(
    'rejects a non-exact HTTPS origin %s', (origin) => {
      expect(() => readCoreRetainedTrust({ ...coreEnv, [N.coreOrigin]: origin }, 'core')).toThrow(CoreRetainedTrustConfigError);
    });

  it('rejects a non-Ed25519 key and a mismatched public pin', () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    expect(() => readCoreRetainedTrust({ ...coreEnv, [N.principalPrivateKey]: rsa }, 'core')).toThrow(CoreRetainedTrustConfigError);
    expect(() => readCoreRetainedTrust({ ...coreEnv, [N.principalPublicKey]: probeKeys.publicPem }, 'core')).toThrow(CoreRetainedTrustConfigError);
    expect(readCoreRetainedTrust({ ...coreEnv, [N.principalPublicKey]: principalKeys.publicPem }, 'core')).not.toBeNull();
  });

  it('never lets the verifier-only role hold a signing key, even in a public-key variable', () => {
    expect(() => readCoreRetainedTrust({ ...intelEnv, [N.principalPrivateKey]: principalKeys.privatePem }, 'intel')).toThrow(CoreRetainedTrustConfigError);
    expect(() => readCoreRetainedTrust({ ...intelEnv, [N.probePublicKey]: probeKeys.privatePem }, 'intel')).toThrow(CoreRetainedTrustConfigError);
    const intel = readCoreRetainedTrust(intelEnv, 'intel');
    expect(intel?.principal.privateKey).toBeNull();
    expect(intel?.probe.privateKey).toBeNull();
  });

  it('accepts single-line PEM with escaped newlines', () => {
    const escaped = principalKeys.privatePem.replace(/\n/g, '\\n');
    expect(readCoreRetainedTrust({ ...coreEnv, [N.principalPrivateKey]: escaped }, 'core')).not.toBeNull();
  });
});

describe('retained trust composition with real Ed25519 envelopes', () => {
  const core = readCoreRetainedTrust(coreEnv, 'core');
  const intel = readCoreRetainedTrust(intelEnv, 'intel');
  const ports = createRetainedPrincipalPorts(core)!;

  it.each([
    ['get_research_portfolio', 'https://core.example.invalid'],
    ['get_research_portfolio_changes', 'https://core.example.invalid'],
    ['get_florida_budget_project', 'https://intel.example.invalid'],
  ] as Array<['get_research_portfolio' | 'get_research_portfolio_changes' | 'get_florida_budget_project', string]>)(
    'signs %s for its fixed recipient and verifies with the same pins', (operation, audience) => {
    const header = ports.signers[operation].sign(facts, { nowMs, deadlineMs: nowMs + 30_000 });
    expect(header.startsWith('CapiroRetained ')).toBe(true);
    expect(decode(header)).toMatchObject({
      purpose: 'capiro-retained-read-principal', algorithm: 'Ed25519', keyId: 'retained-principal-1',
      issuer: 'capiro-core-retained', audienceOrigin: audience, recipientPath: DATA_PATHS[operation], operation,
    });
    const envelope = ports.verifiers[operation].verifyCryptographically(header, { nowMs, deadlineMs: nowMs + 30_000, expectedDigests });
    expect(envelope.principal).toEqual(facts.principal);
  });

  it('addresses Florida data exactly where the verifier-only Intel pins expect it', () => {
    const header = ports.signers.get_florida_budget_project.sign(facts, { nowMs, deadlineMs: nowMs + 30_000 });
    const intelVerifier = createCoreRetainedPrincipalCryptographicVerifier({
      canonicalize: canonicalizeCoreRetainedJson, keyId: intel!.principal.keyId, issuer: intel!.issuer,
      audienceOrigin: intel!.intelOrigin, recipientPath: CORE_RETAINED_FLORIDA_DATA_PATH,
      operation: 'get_florida_budget_project', publicKey: intel!.principal.publicKey,
    });
    expect(intelVerifier.verifyCryptographically(header, { nowMs, deadlineMs: nowMs + 30_000, expectedDigests }).operation)
      .toBe('get_florida_budget_project');
  });

  it('refuses a portfolio envelope at another recipient and a probe-key signature on data', () => {
    const header = ports.signers.get_research_portfolio.sign(facts, { nowMs, deadlineMs: nowMs + 30_000 });
    expect(() => ports.verifiers.get_research_portfolio_changes.verifyCryptographically(
      header, { nowMs, deadlineMs: nowMs + 30_000, expectedDigests })).toThrow();
    const wrongKey = createRetainedPrincipalPorts({ ...core!, principal: core!.probe })!;
    const forged = wrongKey.signers.get_research_portfolio.sign(facts, { nowMs, deadlineMs: nowMs + 30_000 });
    expect(() => ports.verifiers.get_research_portfolio.verifyCryptographically(
      forged, { nowMs, deadlineMs: nowMs + 30_000, expectedDigests })).toThrow();
  });

  it('verifies the authority-only probe Core signs for Intel, and only with the probe key', () => {
    const verifier = createRetainedFloridaProbeVerifier(core)!;
    const probeFacts = {
      principal: facts.principal, identityRevision: facts.identityRevision, currentAuthority: facts.currentAuthority,
      issuedAtMs: nowMs, originalExpiresAtMs: nowMs + 30_000,
      selector: { schemaVersion: 1 as const, sessionKey: '', folderId: null, clientSelector: null },
    };
    const pins = {
      canonicalize: canonicalizeCoreRetainedJson, issuer: core!.issuer, audienceOrigin: core!.intelOrigin,
      recipientPath: CORE_RETAINED_AUTHORITY_PROBE_RECIPIENT_PATH, operation: CORE_RETAINED_AUTHORITY_PROBE_OPERATION,
    };
    const header = createCoreRetainedAuthorityProbeSigner({ ...pins, keyId: core!.probe.keyId, privateKey: core!.probe.privateKey! })
      .sign(probeFacts, { nowMs, deadlineMs: nowMs + 30_000 });
    expect(header.startsWith('CapiroRetainedAuthority ')).toBe(true);
    const bounds = { nowMs, deadlineMs: nowMs + 30_000, selector: probeFacts.selector };
    expect(verifier.verifyCryptographically(header, bounds as never).principal).toEqual(facts.principal);
    const forged = createCoreRetainedAuthorityProbeSigner({ ...pins, keyId: core!.probe.keyId, privateKey: core!.principal.privateKey! })
      .sign(probeFacts, { nowMs, deadlineMs: nowMs + 30_000 });
    expect(() => verifier.verifyCryptographically(forged, bounds as never)).toThrow();
  });

  it('builds a configured Florida authority port that never fetches during composition', () => {
    const fetchImpl = jest.fn();
    expect(typeof createRetainedFloridaAuthorityPort(core, fetchImpl as never).read).toBe('function');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
