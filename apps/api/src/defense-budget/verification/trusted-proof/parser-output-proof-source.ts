/**
 * R8.2 Workstream C — parser-output proof contract.
 *
 * Fields inside the candidate artifact are NOT independent proof of the
 * parser output that produced the artifact. Independent proof requires
 * loading the persisted parser output bytes and verifying them against the
 * parser-run declaration. This file defines the narrow verifier-owned
 * contract injected into `ParserRunProofResolver`.
 *
 * Phase 2 only READS immutable parser output and run metadata through this
 * contract. It never initiates parsing or escalation.
 */
import type { ExtractionMethodV1 } from '../../contracts/extraction-artifact-v1.js';

export interface ParserOutputProofRequestV1 {
  parserRunId: string;
  method: ExtractionMethodV1;
  sourceDocumentId: string;
  providerJobId?: string;
  declaredOutputSha256: string;
}

export interface ResolvedParserOutputProof {
  /** Identity of the persisted run/output that was loaded. */
  persistedRunId: string;
  /** Locator the output bytes were loaded from. */
  outputLocator: string;
  /** The independently loaded output bytes. */
  outputBytes: Buffer;
  /** Source SHA recorded on the persisted run/output. */
  inputSourceSha256: string;
  /** Parser version recorded on the persisted run/output. */
  parserVersion: string;
  /** Parser config SHA recorded on the persisted run/output. */
  parserConfigSha256: string;
  providerJobId?: string;
  /** Terminal status recorded on the persisted run ('succeeded', ...). */
  status: string;
  /** Canonical content SHA of the parsed output contract (local parsers). */
  outputContentSha256?: string;
  /** Raw byte SHA recomputed from the loaded bytes. */
  outputByteSha256?: string;
  /** Pages the persisted run reports as successfully parsed (coverage). */
  succeededPages?: readonly number[];
}

/**
 * Verifier-owned source of independently persisted parser output.
 *
 * Return `null` when the parser output was never persisted independently
 * (legacy runs) — the resolver then reports `missing`, never `verified`.
 * Throw when persisted output exists but fails independent verification
 * (byte mismatch, contract invalid, corrupted store entry) — the resolver
 * then reports `mismatch`.
 */
export interface ParserOutputProofSource {
  resolveParserOutput(input: ParserOutputProofRequestV1): Promise<ResolvedParserOutputProof | null>;
}
