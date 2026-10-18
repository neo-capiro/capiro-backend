import { canonicalizeCoreRetainedJson } from '@capiro/shared/core-retained-jcs';
import { readCoreRetainedTrust, type CoreRetainedTrust } from '@capiro/shared/core-retained-trust';
import { createCoreRetainedPrincipalCryptographicVerifier } from '@capiro/shared/core-retained-principal';
import {
  CORE_RETAINED_AUTHORITY_PROBE_OPERATION,
  CORE_RETAINED_AUTHORITY_PROBE_RECIPIENT_PATH,
  createCoreRetainedAuthorityProbeCryptographicVerifier,
} from '@capiro/shared/core-retained-authority-probe';
import {
  CORE_RETAINED_FLORIDA_DATA_PATH,
  createIntelCoreAuthorityClient,
  type CoreRetainedAuthorityFetch,
} from '@capiro/shared/core-retained-authority-http';
import type { RetainedFloridaPorts } from './retained-florida-read.service.js';

const fetchPort: CoreRetainedAuthorityFetch = (url, init) => fetch(url, init);

/** Intel verifies only. It holds public keys and never a signing key; the
 * shared loader refuses a private key for this role. Both Intel recipients are
 * addressed to the pinned Intel origin. */
export function createIntelRetainedFloridaPorts(
  trust: CoreRetainedTrust | null,
  fetchImpl: CoreRetainedAuthorityFetch = fetchPort,
): RetainedFloridaPorts | null {
  if (!trust) return null;
  const canonicalize = canonicalizeCoreRetainedJson;
  return Object.freeze({
    canonicalize,
    probeVerifier: createCoreRetainedAuthorityProbeCryptographicVerifier({
      canonicalize,
      keyId: trust.probe.keyId,
      issuer: trust.issuer,
      audienceOrigin: trust.intelOrigin,
      recipientPath: CORE_RETAINED_AUTHORITY_PROBE_RECIPIENT_PATH,
      operation: CORE_RETAINED_AUTHORITY_PROBE_OPERATION,
      publicKey: trust.probe.publicKey,
    }),
    dataVerifier: createCoreRetainedPrincipalCryptographicVerifier({
      canonicalize,
      keyId: trust.principal.keyId,
      issuer: trust.issuer,
      audienceOrigin: trust.intelOrigin,
      recipientPath: CORE_RETAINED_FLORIDA_DATA_PATH,
      operation: 'get_florida_budget_project',
      publicKey: trust.principal.publicKey,
    }),
    current: createIntelCoreAuthorityClient({
      coreOrigin: trust.coreOrigin,
      intelOrigin: trust.intelOrigin,
      fetch: fetchImpl,
      canonicalize,
    }),
  });
}

/** Read once at module composition. Disabled or absent configuration yields
 * null ports and both signed Intel routes answer 503. */
export function intelRetainedFloridaPortsFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): RetainedFloridaPorts | null {
  return createIntelRetainedFloridaPorts(readCoreRetainedTrust(env, 'intel'));
}
