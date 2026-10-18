import { readFileSync, statSync } from 'node:fs';

const origin = 'https://portfolio-preview.app.capiro.ai';
const fixedParameters = Object.freeze({
  CoreApiBaseUrl: `${origin}/api`,
  StrategyApiBaseUrl: '',
  WorkspaceApiBaseUrl: `${origin}/workspace-api`,
  IntelligenceApiBaseUrl: `${origin}/intel-api`,
  ExistingAppUrl: origin,
  TrackerBackend: 'intelligence',
});
const patterns = Object.freeze({
  clerkIssuer: /^https:\/\/[a-z0-9-]+\.clerk\.accounts\.dev$/,
  clerkApplicationId: /^app_[A-Za-z0-9]{8,80}$/,
  clerkPublishableKeyArn: /^arn:aws:secretsmanager:us-east-1:967807252336:secret:\/capiro\/preview\/clerk\/publishable-key-[A-Za-z0-9]{6}$/,
  clerkSecretArn: /^arn:aws:secretsmanager:us-east-1:967807252336:secret:\/capiro\/preview\/clerk\/secret-key-[A-Za-z0-9]{6}$/,
  clerkKeyArn: /^arn:aws:kms:us-east-1:967807252336:key\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
});

function closedRecord(input, keys, code) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.getPrototypeOf(input) !== Object.prototype
      || Object.keys(input).sort().join('|') !== [...keys].sort().join('|')
      || keys.some(key => !Object.hasOwn(Object.getOwnPropertyDescriptor(input, key), 'value'))) {
    throw Error(code);
  }
}

/** Public metadata only. This does not read credentials or establish application authority. */
export function renderPreviewConfiguration(bindings) {
  closedRecord(bindings, Object.keys(patterns), 'PREVIEW_BINDINGS_SHAPE');
  for (const [name, pattern] of Object.entries(patterns)) {
    const value = bindings[name];
    if (typeof value !== 'string' || value.length > 1024
        || /[\u0000-\u0020\u007f]/.test(value) || !pattern.test(value)) {
      throw Error(`PREVIEW_BINDING_INVALID:${name}`);
    }
  }
  const values = {
    ...fixedParameters,
    ClerkPublishableKeySecretArn: bindings.clerkPublishableKeyArn,
    ClerkSecretKeySecretArn: bindings.clerkSecretArn,
    ClerkKmsKeyArn: bindings.clerkKeyArn,
  };
  return {
    schemaVersion: 1,
    status: 'configuration-proposal',
    profile: 'portfolio-preview',
    backendSource: '0f1e663d5c23ed3f6f02bde801da8f5bb3f8ccba',
    parameters: Object.entries(values).map(([ParameterKey, ParameterValue]) => ({ ParameterKey, ParameterValue })),
    environment: {
      CORE_API_BASE_URL: fixedParameters.CoreApiBaseUrl,
      STRATEGY_API_BASE_URL: '',
      WORKSPACE_API_BASE_URL: fixedParameters.WorkspaceApiBaseUrl,
      INTELLIGENCE_API_BASE_URL: fixedParameters.IntelligenceApiBaseUrl,
      CAPIRO_EXISTING_APP_URL: origin,
      TRACKER_BACKEND: 'intelligence',
      ONBOARD_API_BASE_URL: '',
      MERI_API_BASE_URL: '',
      MERI_ACTION_WORKFLOW_ENABLED: 'false',
      MERI_DOCUMENT_WORKFLOW_ENABLED: 'false',
      MERI_DOCUMENT_OPERATION: '',
    },
    secretReferences: {
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: bindings.clerkPublishableKeyArn,
      CLERK_SECRET_KEY: bindings.clerkSecretArn,
    },
    clerkMetadata: {
      issuer: bindings.clerkIssuer,
      applicationId: bindings.clerkApplicationId,
      requiredEnvironment: 'test',
    },
    holds: ['strategy', 'onboard', 'meri'],
    activationStatus: 'unverified; all backend services held at zero; not a complete apply request',
  };
}

/** Refuse inherited values, omissions and overrides before a shipping owner combines resource parameters. */
export function validatePreviewParameters(parameters, bindings) {
  const proposal = renderPreviewConfiguration(bindings);
  const expected = new Map(proposal.parameters.map(p => [p.ParameterKey, p.ParameterValue]));
  if (!Array.isArray(parameters) || parameters.length !== expected.size) throw Error('PREVIEW_PARAMETERS_SHAPE');
  const seen = new Set();
  for (const item of parameters) {
    closedRecord(item, ['ParameterKey', 'ParameterValue'], 'PREVIEW_PARAMETER_SHAPE');
    if (!expected.has(item.ParameterKey) || seen.has(item.ParameterKey)
        || item.ParameterValue !== expected.get(item.ParameterKey)) throw Error('PREVIEW_PARAMETER_MISMATCH');
    seen.add(item.ParameterKey);
  }
}

function readMetadata(path) {
  if (statSync(path).size > 32768) throw Error('PREVIEW_METADATA_TOO_LARGE');
  return JSON.parse(readFileSync(path, 'utf8'));
}

function main(args) {
  const usage = 'Usage: node apps/web/deployment/portfolio/preview-config.mjs --bindings FILE [--parameters FILE]\nLocal public-metadata validation only; JSON proposal on stdout. No environment fallback, network, AWS or secret reads.\nExit 0: proposal/help; exit 1: missing or invalid metadata; exit 2: invalid usage.';
  if (args.length === 1 && args[0] === '--help') { console.log(usage); return; }
  if (![2, 4].includes(args.length) || args[0] !== '--bindings' || !args[1]
      || args[1].startsWith('--') || (args.length === 4 && (args[2] !== '--parameters' || !args[3] || args[3].startsWith('--')))) {
    console.error(usage); process.exitCode = 2; return;
  }
  try {
    const bindings = readMetadata(args[1]);
    const proposal = renderPreviewConfiguration(bindings);
    if (args.length === 4) validatePreviewParameters(readMetadata(args[3]), bindings);
    console.log(JSON.stringify(proposal, null, 2));
  } catch (error) {
    const message = error instanceof Error && /^PREVIEW_[A-Z_]+(?::[A-Za-z]+)?$/.test(error.message)
      ? error.message : 'PREVIEW_METADATA_UNAVAILABLE_OR_INVALID';
    console.error(message); process.exitCode = 1;
  }
}

// Native Node24 entry detection also handles worktree and executable symlinks.
if (import.meta.main) main(process.argv.slice(2));
