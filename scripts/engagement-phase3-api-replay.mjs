#!/usr/bin/env node
/**
 * Replay every unique browser-observed Engagement GET through main and the
 * shadow runtime against the same fixture database. This upgrades browser
 * rendering proof from "both loaded" to status/body parity on the exact reads
 * the current SPA issued.
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function isEngagementGet(row) {
  if (row?.method !== 'GET') return false;
  try {
    const pathname = new URL(row.url).pathname;
    return pathname === '/api/engagement' || pathname.startsWith('/api/engagement/');
  } catch {
    return false;
  }
}

function pathAndSearch(url) {
  const parsed = new URL(url);
  return `${parsed.pathname}${parsed.search}`;
}

const DROP_KEYS = new Set(['time', 'timestamp', 'requestId', 'traceId']);
const MASK_KEYS = /^(createdAt|updatedAt|generatedAt|lastSyncedAt|expiresAt|signedUrl|uploadUrl|downloadUrl)$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

export function normalizeParityValue(value, key = '') {
  if (DROP_KEYS.has(key)) return undefined;
  if (MASK_KEYS.test(key)) return `<${key}>`;
  if (typeof value === 'string') {
    if (ISO.test(value) && (key === 'from' || key === 'to')) return `<${key || 'iso'}>`;
    if (/^https?:\/\//i.test(value) && /(?:X-Amz-|Signature=|sig=)/i.test(value)) return '<signed-url>';
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => normalizeParityValue(item));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      const normalized = normalizeParityValue(childValue, childKey);
      if (normalized !== undefined) out[childKey] = normalized;
    }
    return out;
  }
  return value;
}

async function request(base, relative, token, expectShadow) {
  const response = await fetch(`${base}${relative}`, {
    headers: { Authorization: `Bearer ${token}` },
    redirect: 'manual',
  });
  const text = await response.text();
  let body = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // keep text
  }
  const service = response.headers.get('x-capiro-service');
  if (expectShadow && service !== 'engagement-api') {
    throw new Error(`${relative}: shadow replay missing X-Capiro-Service: engagement-api`);
  }
  return { status: response.status, body: normalizeParityValue(body), service };
}

export async function replayObservedReads({
  token,
  network,
  mainUrl = 'http://127.0.0.1:4000',
  shadowUrl = 'http://127.0.0.1:4500',
}) {
  if (typeof token !== 'string' || token.length < 20) {
    throw new Error('Phase 3 bearer token is empty or invalid');
  }
  const paths = Array.from(new Set(network.filter(isEngagementGet).map((row) => pathAndSearch(row.url))));
  if (!paths.length) throw new Error('No browser-observed Engagement GETs available for replay');

  const results = [];
  for (const relative of paths) {
    const mainResult = await request(mainUrl, relative, token, false);
    const shadowResult = await request(shadowUrl, relative, token, true);
    const equal =
      mainResult.status === shadowResult.status &&
      JSON.stringify(mainResult.body) === JSON.stringify(shadowResult.body);
    results.push({ relative, main: mainResult, shadow: shadowResult, equal });
    if (mainResult.status === 401 || shadowResult.status === 401) {
      throw new Error(`${relative}: authenticated parity replay returned 401`);
    }
    if (!equal) {
      throw new Error(`${relative}: main/shadow replay mismatch (${mainResult.status}/${shadowResult.status})`);
    }
  }
  return results;
}

async function main() {
  const evidence = required('ENGAGEMENT_PHASE3_EVIDENCE_DIR');
  const tokenFile = required('ENGAGEMENT_PHASE3_ADMIN_TOKEN_FILE');
  const mainUrl = process.env.ENGAGEMENT_PHASE3_MAIN_URL ?? 'http://127.0.0.1:4000';
  const shadowUrl = process.env.ENGAGEMENT_PHASE3_ENGAGEMENT_URL ?? 'http://127.0.0.1:4500';
  const networkFile = path.join(evidence, 'network-results.json');
  const token = (await readFile(tokenFile, 'utf8')).trim();
  const network = JSON.parse(await readFile(networkFile, 'utf8'));
  const results = await replayObservedReads({ token, network, mainUrl, shadowUrl });

  await writeFile(
    path.join(evidence, 'read-parity.json'),
    `${JSON.stringify({ marker: 'ENGAGEMENT_PHASE3_READ_PARITY_COMPLETE', count: results.length, results }, null, 2)}\n`,
  );
  console.log(`ENGAGEMENT_PHASE3_READ_PARITY_COMPLETE count=${results.length}`);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  });
}
