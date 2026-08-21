#!/usr/bin/env node
/**
 * Phase 8 Session 8 — materialise the real discovery-channel corpus.
 *
 * Downloads each resource in the governed corpus from its official publisher,
 * hashes it, asserts the claims the corpus makes about it, and writes a prepared
 * corpus under a gitignored workdir. Official bytes are never committed.
 *
 * The assertions matter as much as the download. A corpus that merely *claims* a
 * title lacks a fiscal-year phrase, or that a host refuses us, is a comment. This
 * script proves each claim against the live response, including the negative ones
 * — Session 7's closeout called out that claimed-absent evidence has to be
 * verified absent, not just asserted.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const workdir = path.join(root, '.session8-discovery');
const corpusPath = path.join(root, 'docs/defense-budget/phase8-session8-discovery-corpus.json');

const corpus = JSON.parse(fs.readFileSync(corpusPath, 'utf8'));
if (corpus.schemaVersion !== 'phase8_session8_discovery_corpus_v1') {
  console.error(`Unexpected corpus schemaVersion: ${corpus.schemaVersion}`);
  process.exit(1);
}

fs.mkdirSync(path.join(workdir, 'resources'), { recursive: true });

const failures = [];
const prepared = [];

/** Publisher error pages that arrive with a 200 status. */
const SOFT_404 = /Page Not Found \| GovInfo|<title>\s*404\b/i;

for (const resource of corpus.resources) {
  const target = path.join(workdir, 'resources', `${resource.resourceKey}.bin`);
  let status = null;
  let body = null;
  let bytes = null;
  let failureReason = null;

  try {
    const response = await fetch(resource.officialUrl, {
      headers: { 'user-agent': corpus.userAgent, accept: '*/*' },
      redirect: 'follow',
      signal: AbortSignal.timeout(120_000),
    });
    status = response.status;
    if (response.ok) {
      bytes = Buffer.from(await response.arrayBuffer());
      body = bytes.toString('utf8');
      fs.writeFileSync(target, bytes);
    }
  } catch (error) {
    failureReason = error instanceof Error ? error.message : String(error);
  }

  const record = {
    resourceKey: resource.resourceKey,
    adapterId: resource.adapterId,
    resourceKind: resource.resourceKind,
    officialUrl: resource.officialUrl,
    statusCode: status,
    expectedStatus: resource.expectedStatus,
    sha256: bytes ? createHash('sha256').update(bytes).digest('hex') : null,
    byteSize: bytes ? bytes.length : null,
    failureReason,
    path: bytes ? path.relative(root, target).replaceAll('\\', '/') : null,
  };

  // A resource the corpus expects to be refused is validated as refused.
  if (resource.expectedUnreachable === true || resource.expectedStatus >= 400) {
    if (status !== null && status < 400) {
      failures.push(
        `${resource.resourceKey}: corpus expects a refusal but the publisher answered ${status}. ` +
          'The corpus claim is now wrong and must be updated rather than ignored.',
      );
    }
    record.refusalConfirmed = status === null || status >= 400;
    prepared.push(record);
    continue;
  }

  if (status !== resource.expectedStatus) {
    failures.push(
      `${resource.resourceKey}: expected HTTP ${resource.expectedStatus}, got ${status ?? 'no response'}` +
        (failureReason ? ` (${failureReason})` : ''),
    );
    prepared.push(record);
    continue;
  }

  if (body !== null && SOFT_404.test(body)) {
    failures.push(
      `${resource.resourceKey}: publisher answered 200 with an error page (soft 404), ` +
        'which must never be treated as content',
    );
    prepared.push(record);
    continue;
  }

  for (const needle of resource.assertContains ?? []) {
    if (!body?.includes(needle)) {
      failures.push(`${resource.resourceKey}: missing required content "${needle}"`);
    }
  }

  // Claimed-absent evidence is verified absent, not merely asserted.
  for (const needle of resource.assertAbsent ?? []) {
    if (body?.includes(needle)) {
      failures.push(
        `${resource.resourceKey}: corpus claims "${needle}" is absent, but the publisher serves it`,
      );
    }
  }

  if (resource.expectedMinimumEntries !== undefined) {
    const entries = (body?.match(/<loc>/g) ?? []).length;
    record.entryCount = entries;
    if (entries < resource.expectedMinimumEntries) {
      failures.push(
        `${resource.resourceKey}: expected at least ${resource.expectedMinimumEntries} entries, found ${entries}`,
      );
    }
  }

  for (const packageId of resource.expectedPackageIds ?? []) {
    if (!body?.includes(packageId)) {
      failures.push(`${resource.resourceKey}: expected package ${packageId} not present`);
    }
  }

  if (resource.expectedTitle) {
    // The FIRST title is the document's own subject; later ones describe related
    // items and would misclassify.
    const title = /<title>\s*([\s\S]*?)\s*<\/title>/i.exec(body ?? '')?.[1]?.replace(/\s+/g, ' ').trim();
    record.title = title ?? null;
    if (title !== resource.expectedTitle) {
      failures.push(
        `${resource.resourceKey}: expected title "${resource.expectedTitle}", got "${title ?? 'none'}"`,
      );
    }
    if (resource.assertTitleLacksFiscalYearPhrase === true && title) {
      if (/fiscal\s+year/i.test(title)) {
        failures.push(
          `${resource.resourceKey}: corpus claims this title states no "fiscal year" phrase, ` +
            `but it does: "${title}"`,
        );
      } else {
        record.fiscalYearPhraseAbsentConfirmed = true;
      }
    }
  }

  if (resource.expectedCrawlDelaySeconds !== undefined) {
    const declared = /^\s*crawl-delay\s*:\s*([0-9.]+)/im.exec(body ?? '')?.[1];
    record.crawlDelaySeconds = declared ? Number(declared) : null;
    if (Number(declared) !== resource.expectedCrawlDelaySeconds) {
      failures.push(
        `${resource.resourceKey}: expected Crawl-delay ${resource.expectedCrawlDelaySeconds}, ` +
          `got ${declared ?? 'none'}`,
      );
    }
    const effective = Math.max(
      resource.expectedRegistryIntervalMs ?? 0,
      Number(declared ?? 0) * 1_000,
    );
    record.effectiveIntervalMs = effective;
    if (effective !== resource.expectedEffectiveIntervalMs) {
      failures.push(
        `${resource.resourceKey}: effective interval ${effective}ms does not match the ` +
          `expected ${resource.expectedEffectiveIntervalMs}ms`,
      );
    }
  }

  prepared.push(record);
}

const preparedPath = path.join(workdir, 'prepared-corpus.json');
fs.writeFileSync(
  preparedPath,
  `${JSON.stringify(
    {
      schemaVersion: 'phase8_session8_discovery_prepared_corpus_v1',
      preparedFrom: path.relative(root, corpusPath).replaceAll('\\', '/'),
      userAgent: corpus.userAgent,
      resources: prepared,
    },
    null,
    2,
  )}\n`,
);

console.log(`prepared ${prepared.length} discovery resources -> ${path.relative(root, preparedPath)}`);
for (const record of prepared) {
  console.log(
    `  ${String(record.statusCode ?? '---').padEnd(4)} ${record.resourceKind.padEnd(14)} ` +
      `${(record.sha256 ?? '(no bytes)').slice(0, 16).padEnd(18)} ${record.officialUrl}`,
  );
}

if (failures.length > 0) {
  console.error('\nSESSION8_DISCOVERY_CORPUS_FAIL');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log('\nSESSION8_DISCOVERY_CORPUS_PASS');
