#!/usr/bin/env tsx
/**
 * Local/read-only Phase 5 manifest preflight.
 *
 * No parser, provider, database, AWS, or canonical writer is invoked. The
 * report is deterministic and states exactly which required inputs are still
 * absent before extraction can begin.
 */
import {
  PHASE5_EXIT,
  loadPhase5Manifest,
  parseFamily,
  refuseUnknownFlags,
  requireValue,
  selectPhase5Documents,
  valueAfter,
} from './lib/non-rdte-phase5-operator-lib.js';
import { getFamilyProfile } from '../src/defense-budget/contracts/family-completeness-profiles-v1.js';

function main(): void {
  const argv = process.argv.slice(2);
  refuseUnknownFlags(argv, ['--manifest', '--family']);
  const manifestPath = requireValue(argv, '--manifest');
  const family = parseFamily(valueAfter(argv, '--family'));
  const loaded = loadPhase5Manifest(manifestPath);
  const documents = selectPhase5Documents(loaded.manifest, family);
  if (documents.length === 0) {
    throw new Error(`manifest contains no Phase 5 documents${family ? ` for ${family}` : ''}`);
  }

  const rows = documents.map((document) => {
    const profile = getFamilyProfile(document.exhibit);
    const blockers: string[] = [];
    if (document.expectedSourceSha256 == null) blockers.push('expected_source_sha_missing');
    if (document.account == null || document.account.trim() === '') {
      blockers.push('account_missing');
    }
    if (document.required && document.allowEmpty) blockers.push('required_document_allows_empty');
    if (profile == null) blockers.push('family_profile_missing');
    return {
      documentKey: document.documentKey,
      family: document.family,
      exhibit: document.exhibit,
      required: document.required,
      parserPolicy: document.parserPolicy,
      sourceLocator: document.sourceLocator,
      expectedSourceSha256: document.expectedSourceSha256 ?? null,
      account: document.account ?? null,
      summaryDetailRole: document.summaryDetailRole ?? null,
      expectedLineKinds: document.expectedLineKinds,
      requiredDataCategories: document.requiredDataCategories,
      requiredQuantityCategories: document.requiredQuantityCategories ?? [],
      requiredUnitCostCategories: document.requiredUnitCostCategories ?? [],
      requiredNarrativeSections: document.requiredNarrativeSections ?? [],
      authoritativeComparisonKeys: document.authoritativeComparisonKeys ?? [],
      profile:
        profile == null
          ? null
          : {
              expectedLineKind: profile.expectedLineKind,
              summaryDetailRole: profile.summaryDetailRole,
              requiredDataCategories: profile.requiredDataCategories,
              requiresAccount: profile.requiresAccount,
              requiresComponent: profile.requiresComponent,
              requiresBaseAdvanceDesignation: profile.requiresBaseAdvanceDesignation ?? false,
              expectedHierarchyDepth: profile.expectedHierarchyDepth ?? null,
              requiresProjectNumber: profile.requiresProjectNumber ?? false,
              requiredQuantityCategories: profile.requiredQuantityCategories ?? [],
              requiredUnitCostCategories: profile.requiredUnitCostCategories ?? [],
              requiredNarrativeSections: profile.requiredNarrativeSections ?? [],
              blocksCycleWhenMissing: profile.blocksCycleWhenMissing,
            },
      blockers,
    };
  });
  const blockerCount = rows.reduce((sum, row) => sum + row.blockers.length, 0);
  process.stdout.write(
    `${JSON.stringify(
      {
        command: 'inspect-defense-budget-non-rdte',
        mode: 'read_only_local',
        manifestPath,
        manifestContentSha256: loaded.contentSha256,
        cycleId: loaded.manifest.cycleId,
        fiscalYear: loaded.manifest.fiscalYear,
        family: family ?? 'all',
        documentCount: rows.length,
        requiredDocumentCount: rows.filter((row) => row.required).length,
        blockerCount,
        documents: rows,
        externalCalls: false,
        paidParserCalls: false,
        canonicalWrites: false,
      },
      null,
      2,
    )}\n`,
  );
  process.exitCode = blockerCount === 0 ? PHASE5_EXIT.ok : PHASE5_EXIT.incomplete;
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = PHASE5_EXIT.operational;
}
