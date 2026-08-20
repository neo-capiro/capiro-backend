#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import {
  buildSession5BenchmarkCorpus,
  canonicalCorpusJson,
  loadCorpusReviewLedger,
  validateCorpusReviewLedger,
} from '../src/corpus-review.mjs';

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (!argv[index].startsWith('--')) continue;
    const name = argv[index].slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) result[name] = true;
    else {
      result[name] = next;
      index += 1;
    }
  }
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const ledgerPath =
    args.ledger ??
    'docs/defense-budget/phase8-session5-corpus-review-ledger.json';
  const { ledger, evidenceByPath } = await loadCorpusReviewLedger(ledgerPath);
  const analysis = validateCorpusReviewLedger(ledger, evidenceByPath);
  const report = {
    ledgerPath,
    ledgerSha256: ledger.contentSha256,
    acceptedEntryCount: analysis.acceptedEntryCount,
    acceptedStrata: analysis.acceptedStrata,
    blockedStrata: analysis.blockedStrata,
    liveCorpusReady: analysis.liveCorpusReady,
  };

  if (!analysis.liveCorpusReady) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.stderr.write(
      `${JSON.stringify({
        code: 'LIVE_CORPUS_NOT_READY',
        message:
          'No live corpus file was written because source-grounded gold is incomplete.',
        blockedStrata: analysis.blockedStrata,
      })}\n`,
    );
    process.exitCode = 2;
    return;
  }

  const corpus = buildSession5BenchmarkCorpus(ledger, analysis);
  if (args.out) {
    const outputPath = resolve(args.out);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${canonicalCorpusJson(corpus)}\n`, 'utf8');
    report.outputPath = outputPath;
  }
  process.stdout.write(`${JSON.stringify({ ...report, corpus }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(
    `${JSON.stringify({
      error: error?.name ?? 'Error',
      code: error?.code ?? 'SESSION5_CORPUS_BUILD_FAILED',
      message: error?.message ?? String(error),
      details: error?.details,
    })}\n`,
  );
  process.exitCode = 1;
});
