// Pure receipt/assertion contract. Only the native operator supplies HTTP ports;
// source-policy verification never invokes this probe or writes native evidence.
export const AUTH_RECOVERY_CASE = 'auth-rejection-then-recovery';
export const AUTH_RECOVERY_CALL = `    results.push(await probeAuthRejectionRecovery({
      fetchResult, url: \`\${FAULT_URL}/api/engagement/tasks?clientId=\${encodeURIComponent(clientId)}\`,
      taskId: retryTaskId, authenticatedHeaders: (preview) => headers(token, preview),
    }));\n\n`;
export const AUTH_RECOVERY_IMPORT = "import { probeAuthRejectionRecovery } from './engagement-phase3-resilience-contract.mjs';\n";
const ORIGINAL_CASES = [
  'ordinary-429', 'ordinary-500', 'ordinary-502', 'ordinary-503', 'ordinary-504',
  'malformed_json', 'partial_response', 'reset', 'slow-timeout',
  'safe-write-retry-no-duplicate', 'database-after-boot-recovery',
  'database-unavailable-at-boot', 'auth-upstream-unavailable', 'stream-interruption',
];

// An explicit one-call/import inverse preserves the entire earlier native body.
export function withoutAuthRecoveryProbe(source) {
  if (!source.includes(AUTH_RECOVERY_IMPORT)) return source;
  if (source.split(AUTH_RECOVERY_IMPORT).length !== 2 || source.split(AUTH_RECOVERY_CALL).length !== 2) {
    throw new Error('Unqualified auth-recovery native seam');
  }
  return source.replace(AUTH_RECOVERY_IMPORT, '').replace(AUTH_RECOVERY_CALL, '');
}

function requireOwnership(main, preview) {
  if (main?.service !== null || preview?.service !== 'engagement-api') {
    throw new Error('Auth recovery lost main/preview service ownership');
  }
}
function requireAnonymousDenial(result) {
  const body = result?.body;
  if (result?.kind !== 'http' || result.status !== 401 || !body || Array.isArray(body) ||
    typeof body !== 'object' || body.statusCode !== 401 || body.message !== 'Missing bearer token' ||
    (body.error !== undefined && body.error !== 'Unauthorized') ||
    Object.keys(body).some((key) => !['statusCode', 'message', 'error'].includes(key))) {
    throw new Error('Anonymous proxy read did not fail closed with its ordinary missing-bearer 401 envelope');
  }
}
function requireRecoveredRead(result, taskId) {
  if (result?.kind !== 'http' || result.status !== 200 || !Array.isArray(result.body) ||
    result.body.filter((row) => row?.id === taskId).length !== 1) {
    throw new Error('Authenticated proxy read did not recover the one attributable retry row');
  }
}
export function assertAuthRecoveryCase(record, taskId) {
  if (!record || record.id !== AUTH_RECOVERY_CASE || typeof taskId !== 'string' || !taskId ||
    record.taskId !== taskId || record.requestCount !== 4 || record.path !== '/api/engagement/tasks') {
    throw new Error('Auth recovery receipt lacks attributable four-request native probe evidence');
  }
  requireOwnership(record.rejected?.main, record.rejected?.preview);
  requireAnonymousDenial(record.rejected?.main); requireAnonymousDenial(record.rejected?.preview);
  requireOwnership(record.recovered?.main, record.recovered?.preview);
  requireRecoveredRead(record.recovered?.main, taskId); requireRecoveredRead(record.recovered?.preview, taskId);
  if (JSON.stringify(record.recovered.main.body) !== JSON.stringify(record.recovered.preview.body)) {
    throw new Error('Recovered authenticated main/preview task bodies differ');
  }
}

export async function probeAuthRejectionRecovery({ fetchResult, url, taskId, authenticatedHeaders }) {
  if (typeof taskId !== 'string' || !taskId || new URL(url).pathname !== '/api/engagement/tasks') {
    throw new Error('Auth recovery requires the already-created retry row and protected task route');
  }
  // No injected response: these requests must reach the running API guards.
  const [mainDenied, previewDenied] = await Promise.all([
    fetchResult(url, { headers: {} }),
    fetchResult(url, { headers: { 'X-Capiro-Engagement-Preview': 'v3' } }),
  ]);
  requireOwnership(mainDenied, previewDenied);
  requireAnonymousDenial(mainDenied); requireAnonymousDenial(previewDenied);
  const [mainRecovered, previewRecovered] = await Promise.all([
    fetchResult(url, { headers: authenticatedHeaders(false) }),
    fetchResult(url, { headers: authenticatedHeaders(true) }),
  ]);
  const record = { id: AUTH_RECOVERY_CASE, taskId, requestCount: 4, path: '/api/engagement/tasks',
    rejected: { main: mainDenied, preview: previewDenied },
    recovered: { main: mainRecovered, preview: previewRecovered } };
  assertAuthRecoveryCase(record, taskId);
  return record;
}

export function assertResilienceReceipt(document) {
  if (document?.marker !== 'ENGAGEMENT_PHASE3_RESILIENCE_COMPLETE' || document.sourcePolicyOnly === true || document.nativeProofPerformed === false) {
    throw new Error('Source-only or non-native-marker evidence cannot satisfy the native resilience receipt');
  }
  const rows = document?.results;
  if (!Array.isArray(rows) || !Number.isInteger(document.cases) || document.cases !== rows.length || document.cases < 15) {
    throw new Error('Resilience receipt count must equal its at least fifteen actual result identities');
  }
  const ids = rows.map((row) => row?.id);
  if (ids.some((id) => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length ||
    [...ORIGINAL_CASES, AUTH_RECOVERY_CASE].some((id) => !ids.includes(id))) {
    throw new Error('Resilience receipt omits or duplicates required native result identities');
  }
  const taskId = rows.find((row) => row.id === 'safe-write-retry-no-duplicate')?.retriedTask?.body?.id;
  assertAuthRecoveryCase(rows.find((row) => row.id === AUTH_RECOVERY_CASE), taskId);
}
