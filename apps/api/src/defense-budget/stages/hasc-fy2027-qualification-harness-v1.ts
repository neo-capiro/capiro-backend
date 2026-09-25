/**
 * Isolated qualification harness for the governed FY2027 HASC RDT&E mark
 * packet. This is intentionally not a production, backfill, or publication
 * entry point. It writes only beneath the caller-provided temporary root.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { adapterTestContext } from '../contracts/adapters/testing-helpers.js';
import { sha256Bytes, sha256Hex } from '../contracts/canonical-json.js';
import type { CommitteeArtifactV1Input } from '../contracts/adapters/committee-artifact-v1.adapter.js';
import { createHascSourceProfileV1 } from './authorization/hasc-source-profile-v1.js';
import { parseStageSourceProfileV1, stageSourceProfileHashV1 } from './stage-source-profile-v1.js';
import { FilesystemExtractionArtifactStore } from '../parser-router/extraction-artifact-store.js';
import { FilesystemParserArtifactStore } from '../parser-router/parser-artifact-store.js';
import {
  sealParserRuntimeResult,
  type ParserRuntimeResultV1,
} from '../parser-router/parser-runtime-contract-v1.js';
import { buildParserRunIdentityV1 } from '../parser-router/parser-run-identity-v1.js';
import { persistProofBoundCongressionalArtifactV1 } from '../parser-router/congressional-durable-semantic-artifact-factory-v1.js';

export const HASC_FY2027_QUALIFICATION_SOURCE_SHA256 =
  '6587d1cec52d8d3eda3551648f50e4bc15371ea9167da2999e263e8c8e14480a';
export const HASC_FY2027_QUALIFICATION_PACKET_SHA256 =
  '7deb7d1dcb47d97651d8ba43c2e8bc1bdf15b23c4b35fdd956cca852036fa57e';
const HASC_FY2027_REVIEWED_COMPANION_SHA256 =
  '9c99115f7c0f2b836002c543c6e846a45ef512a2e6fc52f59f2b40f96f12b11c';
const HASC_FY2027_RETAINED_S3_URI =
  's3://capiro-defense-budget-raw-dev-967807252336/incoming/fy2027/H._Rept._119-698_-_FY2027_NDAA.pdf';
const HASC_FY2027_RETAINED_S3_VERSION_ID = 'MKREMzqkucbbM4ZYaTic432fWf_Ctnwi';
const PARSER_CONFIG_SHA256 = sha256Hex(
  `package3-hasc-qualification-parser-config-v1:${HASC_FY2027_QUALIFICATION_PACKET_SHA256}`,
);

interface GovernedHascPacketV1 {
  schema: 'governed_congressional_rows_v1';
  documentKey: string;
  extraction: {
    explicitRepairs: Array<{
      page: number;
      peCode: string;
      type: string;
    }>;
    extractorVersion: string;
    markTotalDollars: number;
    parserLibrary: string;
    referenceCompanion: {
      exactPeMarkMultisetMatch: boolean;
      rowCount: number;
      sha256: string;
    };
    requestOmitted: boolean;
    rowCount: number;
  };
  fiscalYear: number;
  rows: Array<{
    explanation?: string;
    fy: number;
    mark: number | string;
    markUnit: 'dollars' | 'thousands' | 'millions';
    page: number;
    peCode: string;
    rowLabel?: string;
  }>;
  source: {
    declaredUnit: string;
    detectedUnits: string[];
    pageRange: { start: number; end: number; numbering: string };
    retainedObject: { uri: string; versionId: string };
    sha256: string;
    url: string;
  };
}

function parserResult(sourceSha256: string, requestedPages: number[]): ParserRuntimeResultV1 {
  return sealParserRuntimeResult({
    schemaVersion: 'defense_budget_parser_result_v1',
    jobId: 'package3-hasc-fy2027-qualification',
    engine: 'manual',
    parserVersion: 'extract_armed_services_report_v2:pypdf-5.9.0:reviewed',
    parserConfigSha256: PARSER_CONFIG_SHA256,
    inputSourceSha256: sourceSha256,
    requestedPages,
    succeededPages: requestedPages,
    failedPages: [],
    pages: requestedPages.map((page) => ({
      page,
      text: null,
      blocks: [],
      tables: [],
      images: [],
      evidencePrecision: 'page_only' as const,
      warnings: [
        'manual governed-packet review covers this page; no extracted source-page text is claimed',
      ],
    })),
    warnings: [
      {
        code: 'manual_governed_packet_qualification',
        message:
          `manual review of packet ${HASC_FY2027_QUALIFICATION_PACKET_SHA256}; ` +
          'parser result carries page coverage only and does not claim source-page text extraction',
        pages: requestedPages,
      },
    ],
    metrics: {
      durationMillis: 0,
      pagesProcessed: requestedPages.length,
      pagesSucceeded: requestedPages.length,
      pagesFailed: 0,
      engineVersion: 'pypdf-5.9.0-reviewed-row-packet',
    },
  });
}

/** Qualify packet data against the proof-bound factory using isolated local storage. */
export async function runHascFy2027QualificationV1(input: {
  packetBytes: Uint8Array;
  artifactRoot: string;
}) {
  const packetByteSha256 = sha256Bytes(input.packetBytes);
  if (packetByteSha256 !== HASC_FY2027_QUALIFICATION_PACKET_SHA256) {
    throw new Error('governed HASC packet bytes do not match the reviewed qualification pin');
  }
  const packet = JSON.parse(
    Buffer.from(input.packetBytes).toString('utf8'),
  ) as GovernedHascPacketV1;
  if (packet.schema !== 'governed_congressional_rows_v1')
    throw new Error('unexpected governed packet schema');
  if (packet.documentKey !== 'CRPT-119hrpt698')
    throw new Error('unexpected HASC source document key');
  if (packet.fiscalYear !== 2027 || packet.rows.some((row) => row.fy !== 2027)) {
    throw new Error('governed HASC packet fiscal year is not FY2027');
  }
  if (
    packet.extraction.extractorVersion !== 'extract_armed_services_report_v2' ||
    packet.extraction.parserLibrary !== 'pypdf-5.9.0' ||
    !packet.extraction.requestOmitted
  ) {
    throw new Error('governed HASC packet extraction provenance is incomplete or unexpected');
  }
  if (
    packet.extraction.explicitRepairs?.length !== 1 ||
    packet.extraction.explicitRepairs[0]?.type !== 'page_edge_authorized_sum' ||
    packet.extraction.explicitRepairs[0]?.page !== 618 ||
    packet.extraction.explicitRepairs[0]?.peCode !== '0602141A'
  ) {
    throw new Error('governed HASC packet explicit repair ledger differs from the review');
  }
  if (
    packet.extraction.referenceCompanion?.sha256 !== HASC_FY2027_REVIEWED_COMPANION_SHA256 ||
    packet.extraction.referenceCompanion.rowCount !== 926 ||
    packet.extraction.referenceCompanion.exactPeMarkMultisetMatch !== true
  ) {
    throw new Error('governed HASC packet lacks the reviewed PE/mark reconciliation proof');
  }
  if (packet.source.sha256 !== HASC_FY2027_QUALIFICATION_SOURCE_SHA256) {
    throw new Error('governed HASC packet source SHA does not match the qualification pin');
  }
  if (packet.source.pageRange.start !== 618 || packet.source.pageRange.end !== 665) {
    throw new Error('governed HASC packet page range differs from the reviewed qualification');
  }
  if (packet.source.pageRange.numbering !== 'physical_pdf_one_based') {
    throw new Error('governed HASC packet must use physical one-based PDF pages');
  }
  if (
    packet.source.declaredUnit !== 'thousands' ||
    packet.source.detectedUnits.length !== 1 ||
    packet.source.detectedUnits[0] !== 'thousands' ||
    packet.rows.some((row) => row.markUnit !== 'thousands')
  ) {
    throw new Error('governed HASC packet unit binding differs from the reviewed qualification');
  }
  if (
    packet.source.retainedObject?.uri !== HASC_FY2027_RETAINED_S3_URI ||
    packet.source.retainedObject.versionId !== HASC_FY2027_RETAINED_S3_VERSION_ID
  ) {
    throw new Error('governed HASC packet retained-object identity differs from the review');
  }
  if (packet.rows.length !== 926 || packet.extraction.rowCount !== 926) {
    throw new Error('governed HASC packet row count differs from the reviewed qualification');
  }
  if (
    packet.rows.some((row) => Object.hasOwn(row, 'request') || Object.hasOwn(row, 'requestUnit'))
  ) {
    throw new Error('governed HASC mark-only packet contains request data');
  }
  const markTotalDollars = packet.rows.reduce((total, row) => total + Number(row.mark) * 1000, 0);
  if (
    markTotalDollars !== 160_628_729_000 ||
    packet.extraction.markTotalDollars !== markTotalDollars
  ) {
    throw new Error('governed HASC packet mark total differs from the reviewed qualification');
  }
  if (packet.rows.some((row) => row.page < 618 || row.page > 665)) {
    throw new Error('governed HASC row page is outside the reviewed packet range');
  }
  const requestedPages = Array.from(
    { length: packet.source.pageRange.end - packet.source.pageRange.start + 1 },
    (_, index) => packet.source.pageRange.start + index,
  );
  const rowsByPage = new Map<number, GovernedHascPacketV1['rows']>();
  for (const row of packet.rows)
    rowsByPage.set(row.page, [...(rowsByPage.get(row.page) ?? []), row]);
  if (requestedPages.some((page) => (rowsByPage.get(page) ?? []).length === 0)) {
    throw new Error('governed HASC packet does not cover every reviewed source page');
  }
  const result = parserResult(packet.source.sha256, requestedPages);
  const identity = buildParserRunIdentityV1({
    sourceSha256: result.inputSourceSha256,
    method: result.engine,
    parserVersion: result.parserVersion,
    parserConfigSha256: result.parserConfigSha256,
    requestedPages: result.requestedPages,
  });
  const resultJson = `${JSON.stringify(result)}\n`;
  const parserStore = new FilesystemParserArtifactStore(join(input.artifactRoot, 'parser-results'));
  const descriptor = await parserStore.putVerified({ identity, result, resultJson });
  const persistedResult = await parserStore.readVerified(descriptor);
  const resultBytes = await readFile(descriptor.resultLocator);
  const profile = parseStageSourceProfileV1({
    ...createHascSourceProfileV1({
      fiscalYear: packet.fiscalYear,
      reportNumber: 'H. Rept. 119-698',
      sourceDocumentKeys: [packet.documentKey],
    }),
    requiredLineFamilies: ['rdte_pe'],
  });
  const profileSha256 = stageSourceProfileHashV1(profile);
  const context = adapterTestContext({
    manifestDocumentKey: packet.documentKey,
    sourceDocumentId: packet.documentKey,
    sourcePdfSha256: packet.source.sha256,
    sourceLocator: packet.source.url,
    sourceUrl: packet.source.url,
    fiscalYear: packet.fiscalYear,
    family: 'committee',
    exhibit: 'committee_report',
    authority: 'hasc',
    component: 'UNKNOWN',
    budgetCycle: 'pb_fy2027',
    documentType: 'HASC authorization committee report',
    parser: {
      method: persistedResult.engine,
      parserVersion: persistedResult.parserVersion,
      parserConfigSha256: persistedResult.parserConfigSha256,
      outputArtifactSha256: persistedResult.contentSha256,
      pageRanges: [
        { startPage: packet.source.pageRange.start, endPage: packet.source.pageRange.end },
      ],
    },
  });
  const committeeInput: CommitteeArtifactV1Input = {
    chamber: 'HASC',
    fy: packet.fiscalYear,
    source: 'governed_congressional_rows_v1',
    rows: packet.rows.map((row) => ({
      peCode: row.peCode,
      fy: row.fy,
      mark: row.mark,
      markUnit: row.markUnit,
      page: row.page,
      rowLabel: row.rowLabel,
      explanation: row.explanation,
    })),
  };
  const output = await persistProofBoundCongressionalArtifactV1({
    budgetFamily: 'committee',
    factoryContext: { profile, context },
    input: committeeInput,
    parserResultProofs: [
      {
        parserRunId: descriptor.parserRunId,
        result: persistedResult,
        resultByteSha256: descriptor.byteSha256,
        resultLocator: descriptor.resultLocator,
      },
    ],
    store: new FilesystemExtractionArtifactStore(join(input.artifactRoot, 'artifacts')),
  });
  return {
    qualification_only: true as const,
    production_registration: false as const,
    backfill: false as const,
    publication: false as const,
    sourceSha256: packet.source.sha256,
    governedPacketSha256: packetByteSha256,
    governedRowCount: packet.rows.length,
    governedMarkTotalDollars: markTotalDollars,
    retainedSourceUri: packet.source.retainedObject.uri,
    retainedSourceVersionId: packet.source.retainedObject.versionId,
    stageProfileSha256: profileSha256,
    sourcePages: [packet.source.pageRange.start, packet.source.pageRange.end] as const,
    parserResultByteSha256: descriptor.byteSha256,
    parserResultByteLength: resultBytes.byteLength,
    artifactId: output.artifactId,
    artifactByteSha256: output.artifactByteSha256,
    artifactLocator: output.artifactLocator,
    sourceFactCount: output.sourceFactCount,
    assertionCount: output.assertionCount,
    evidenceCount: output.evidenceCount,
    warningCount: output.warningCount,
    omissionCount: output.artifact.omissions.length,
    completenessStatus: output.artifact.summary.completenessStatus,
    requestAssertionCount: output.artifact.assertions.filter(
      (assertion) => assertion.assertionKind === 'funding' && assertion.field === 'request',
    ).length,
    markAssertionCount: output.artifact.assertions.filter(
      (assertion) => assertion.assertionKind === 'funding' && assertion.field === 'hascMark',
    ).length,
  };
}
