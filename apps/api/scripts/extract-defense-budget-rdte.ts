#!/usr/bin/env tsx
/** Durable RDT&E stage 1: semantic extraction from persisted Phase 3 composition. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadPhase5Manifest, readJsonFile, refuseUnknownFlags, requireValue, writeJsonFile } from './lib/non-rdte-phase5-operator-lib.js';
import { createRdteSemanticArtifactFactory } from '../src/defense-budget/rdte/cycle/rdte-phase3-semantic-artifact-factory-v1.js';
import type { ComposedPageOutputV1 } from '../src/defense-budget/parser-router/page-result-compositor.js';

interface ParserMapEntry { composedOutputPath: string; sourceDocumentId: string }

function main(): void {
  const argv = process.argv.slice(2);
  refuseUnknownFlags(argv, ['--manifest', '--parser-map', '--out-dir']);
  const manifestPath = path.resolve(requireValue(argv, '--manifest'));
  const outDir = path.resolve(requireValue(argv, '--out-dir'));
  const loaded = loadPhase5Manifest(manifestPath);
  const parserMap = readJsonFile(path.resolve(requireValue(argv, '--parser-map'))) as Record<string, ParserMapEntry>;
  const artifactMap: Record<string, { artifactPath: string; sourceDocumentId: string }> = {};
  fs.mkdirSync(outDir, { recursive: true });
  for (const document of loaded.manifest.documents.filter((value) => value.family === 'rdte')) {
    const entry = parserMap[document.documentKey];
    if (entry == null) {
      if (document.required) throw new Error(`parser map has no entry for required document ${document.documentKey}`);
      continue;
    }
    if (document.expectedSourceSha256 == null) throw new Error(`${document.documentKey} has no expected source SHA`);
    const composedOutput = readJsonFile(path.resolve(entry.composedOutputPath)) as ComposedPageOutputV1;
    const source = {
      manifestDocumentKey: document.documentKey, sourceDocumentId: entry.sourceDocumentId,
      sourcePdfSha256: document.expectedSourceSha256, sourceLocator: document.sourceLocator,
      ...(document.sourceUrl ? { sourceUrl: document.sourceUrl } : {}), fiscalYear: loaded.manifest.fiscalYear,
      family: document.family, exhibit: document.exhibit, authority: document.authority,
      component: document.component, budgetCycle: document.budgetCycle, documentType: document.documentType, title: document.title,
    };
    const semantic = createRdteSemanticArtifactFactory({ document, source, fiscalYear: loaded.manifest.fiscalYear });
    semantic.factory({
      executionId: composedOutput.executionId, cycleId: loaded.manifest.cycleId,
      manifestDocumentKey: document.documentKey, sourceDocumentId: entry.sourceDocumentId,
      sourceSha256: document.expectedSourceSha256, sourceLocator: document.sourceLocator,
      composedOutput, exhibitType: document.exhibit, budgetFamily: 'rdte', fiscalYear: loaded.manifest.fiscalYear,
      authority: document.authority, component: document.component, budgetCycle: document.budgetCycle,
      documentType: document.documentType, title: document.title,
    }, outDir);
    if (semantic.capture.artifact == null || semantic.capture.artifactLocator == null) throw new Error(`semantic capture failed for ${document.documentKey}`);
    const artifactPath = path.resolve(outDir, `${document.documentKey}.extraction-v1.json`);
    writeJsonFile(artifactPath, semantic.capture.artifact);
    artifactMap[document.documentKey] = { artifactPath, sourceDocumentId: entry.sourceDocumentId };
  }
  const artifactMapPath = path.join(outDir, 'artifact-map.json');
  writeJsonFile(artifactMapPath, artifactMap);
  process.stdout.write(`${JSON.stringify({ command: 'extract-defense-budget-rdte', cycleId: loaded.manifest.cycleId, artifactMapPath, canonicalWrites: false }, null, 2)}\n`);
}
try { main(); } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 5; }
