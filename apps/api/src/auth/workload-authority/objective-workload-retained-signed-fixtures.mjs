/** Offline interoperability fixture generator. The private RSA key lives only
 * in this process; the emitted manifest contains the public pin and signed
 * synthetic bytes, never a product credential or an authority decision. */
import { createHash, constants, generateKeyPairSync, sign as rsaSign } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const vectorsUrl = new URL('../../../../../docs/objective-workload-authority-20261015/CORE-MERI-RETAINED-READ-VECTORS-20261016.json', import.meta.url);
const sha = value => createHash('sha256').update(value).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
const encode = bytes => Buffer.from(bytes).toString('base64url');
const fields = ['iss', 'sub', 'aud', 'iat', 'nbf', 'exp', 'jti', 'method', 'path', 'query',
  'bodySha256', 'operation', 'phase', 'tenantId', 'generationJobId', 'delegationRef',
  'consentId', 'attemptId', 'runId', 'acceptedBindingSha256', 'sourceSha256'];

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(
    key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function orderedClaims(value) {
  return Object.fromEntries(fields.map(key => [key, value[key]]));
}

function signSegments(headerBytes, payloadBytes, privateKey, headerSegment, payloadSegment) {
  const h = headerSegment ?? encode(headerBytes);
  const p = payloadSegment ?? encode(payloadBytes);
  const input = `${h}.${p}`;
  const signature = rsaSign('RSA-SHA256', Buffer.from(input, 'ascii'),
    { key: privateKey, padding: constants.RSA_PKCS1_PADDING });
  return `${input}.${encode(signature)}`;
}

function padMember(value, targetBytes) {
  const head = { ...value, x: '' };
  const size = Buffer.byteLength(JSON.stringify(head));
  if (size > targetBytes) throw new Error('Fixture pad target below payload size');
  return { ...value, x: 'x'.repeat(targetBytes - size) };
}

function sourceVariant(vectors, name) {
  const source = clone(vectors.base.source);
  const variant = vectors.sourceVariants[name];
  if (!variant) throw new Error(`Unknown source variant: ${name}`);
  const path = variant.patch.pointer.split('/').slice(3);
  let node = source;
  for (const part of path.slice(0, -1)) node = node[part];
  node[path.at(-1)] = variant.patch.value;
  const raw = JSON.stringify({ schemaVersion: 1, source });
  const hashes = {
    bodySha256: sha(Buffer.from(raw, 'utf8')),
    sourceSha256: sha(Buffer.from(canonical(source), 'utf8')),
    acceptedBindingSha256: sha(Buffer.from(canonical(source.binding), 'utf8')),
  };
  for (const key of Object.keys(hashes)) {
    if (hashes[key] !== variant[key]) throw new Error(`Golden ${name}.${key} differs`);
  }
  return { source, raw, hashes };
}

function applyMutation(state, mutation) {
  const parts = mutation.pointer.split('/').slice(2);
  if (parts[0] === 'rawBodyUtf8') {
    if (mutation.operation !== 'append') throw new Error('Unsupported body mutation');
    state.rawBodyUtf8 += mutation.value;
    return;
  }
  if (parts[0] === 'claims' && parts.length === 1) {
    if (mutation.operation !== 'wrap-in-objective') throw new Error('Unsupported claims mutation');
    state.claims = { objective: state.claims };
    return;
  }
  if (!['claims', 'header'].includes(parts[0])) throw new Error('Unsupported pointer');
  state[parts[0]][parts[1]] = mutation.value;
}

function malformedToken(entry, state, privateKey) {
  const header = state.header;
  const claims = state.claims;
  let h = Buffer.from(JSON.stringify(header), 'utf8');
  let p = Buffer.from(JSON.stringify(claims), 'utf8');
  switch (entry.id) {
    case 'duplicate-claim':
      p = Buffer.from(JSON.stringify(claims).replace(/\}$/, `,"jti":"${claims.jti}"}`), 'utf8');
      break;
    case 'invalid-header-utf8': h = Buffer.from([0xff]); break;
    case 'invalid-payload-utf8': p = Buffer.from([0xff]); break;
    case 'extra-header-member': h = Buffer.from(JSON.stringify({ ...header, x: true })); break;
    case 'extra-payload-member': p = Buffer.from(JSON.stringify({ ...claims, x: true })); break;
    case 'wrong-header-serialization':
      h = Buffer.from(JSON.stringify({ kid: header.kid, alg: header.alg, typ: header.typ })); break;
    case 'wrong-payload-serialization':
      p = Buffer.from(JSON.stringify({ sub: claims.sub, iss: claims.iss, ...Object.fromEntries(
        Object.entries(claims).filter(([key]) => key !== 'sub' && key !== 'iss')) })); break;
    case 'oversize-header': h = Buffer.from(JSON.stringify(padMember(header, 1025))); break;
    case 'oversize-payload': p = Buffer.from(JSON.stringify(padMember(claims, 4097))); break;
    case 'oversize-signing-input': {
      h = Buffer.from(JSON.stringify(padMember(header, 1024)));
      let found = false;
      for (let target = Buffer.byteLength(JSON.stringify({ ...claims, x: '' })); target <= 4096; target++) {
        const trial = Buffer.from(JSON.stringify(padMember(claims, target)));
        if (`${encode(h)}.${encode(trial)}`.length === 4097) { p = trial; found = true; break; }
      }
      if (!found) throw new Error('Could not form 4097-character signing input');
      break;
    }
    default: break;
  }
  const headerSegment = entry.id === 'noncanonical-header-base64url' ? `${encode(h)}=` : undefined;
  const payloadSegment = entry.id === 'noncanonical-payload-base64url' ? `${encode(p)}=` : undefined;
  let token = signSegments(h, p, privateKey, headerSegment, payloadSegment);
  if (entry.id === 'bad-signature') {
    const [one, two, sig] = token.split('.');
    const bytes = Buffer.from(sig, 'base64url');
    bytes[0] ^= 1;
    token = `${one}.${two}.${encode(bytes)}`;
  }
  if (entry.id === 'oversize-compact-token') token += 'A'.repeat(8193 - token.length);
  return token;
}

export async function loadRetainedVectors() {
  return JSON.parse(await readFile(vectorsUrl, 'utf8'));
}

export function createSignedRetainedManifest(vectors, keys = generateKeyPairSync('rsa', { modulusLength: 3072 })) {
  const base = vectors.base;
  if (sha(Buffer.from(base.rawBodyUtf8, 'utf8')) !== base.claims.bodySha256 ||
      sha(Buffer.from(canonical(base.source), 'utf8')) !== base.claims.sourceSha256 ||
      sha(Buffer.from(canonical(base.source.binding), 'utf8')) !== base.claims.acceptedBindingSha256)
    throw new Error('Baseline golden hashes differ');
  for (const name of Object.keys(vectors.sourceVariants)) sourceVariant(vectors, name);
  const cases = vectors.cases.map(entry => {
    const state = { header: clone(base.header), claims: orderedClaims(base.claims),
      rawBodyUtf8: base.rawBodyUtf8 };
    if (entry.sourceVariant) {
      const variant = sourceVariant(vectors, entry.sourceVariant);
      state.rawBodyUtf8 = variant.raw;
      for (const key of entry.updateClaimsFromVariant) {
        state.claims[key] = key in variant.hashes ? variant.hashes[key]
          : key in variant.source ? variant.source[key] : variant.source.binding[key];
      }
    }
    for (const mutation of entry.mutations ?? []) applyMutation(state, mutation);
    if (entry.id === 'oversize-raw-body') {
      state.rawBodyUtf8 += ' '.repeat(65537 - Buffer.byteLength(state.rawBodyUtf8, 'utf8'));
    }
    const token = malformedToken(entry, state, keys.privateKey);
    return { id: entry.id, token, rawBodyBase64: Buffer.from(state.rawBodyUtf8, 'utf8').toString('base64'),
      nowSeconds: entry.nowSeconds ?? base.nowSeconds,
      trustedSource: base.source, expected: entry.expected,
      ...(entry.expectedTrace ? { expectedTrace: entry.expectedTrace } : {}) };
  });
  return {
    schemaVersion: 1,
    kind: 'SIGNED_OFFLINE_CORE_MERI_RETAINED_READ_INTEROP_FIXTURE',
    sourceVectorSha256: sha(Buffer.from(JSON.stringify(vectors), 'utf8')),
    sourcePins: vectors.sourcePins,
    publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    issuer: base.claims.iss, kid: base.header.kid,
    baseClaims: orderedClaims(base.claims),
    cases,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 4 || process.argv[2] !== '--out')
    throw new Error('Usage: node objective-workload-retained-signed-fixtures.mjs --out <task-owned path>');
  const manifest = createSignedRetainedManifest(await loadRetainedVectors());
  await writeFile(process.argv[3], `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  process.stdout.write(`Wrote ${manifest.cases.length} signed synthetic cases; private key discarded.\n`);
}
