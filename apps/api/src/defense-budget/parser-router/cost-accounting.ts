/**
 * defense_budget_cost_accounting_v1 — per-document parser cost accounting.
 *
 * Reports local vs paid page counts and parser execution metrics truthfully.
 * Does not fabricate dollar cost when the provider does not return enough
 * current pricing data.
 */

import type { ExtractionMethodV1 } from '../contracts/extraction-artifact-v1.js';

/* ------------------------------------------------------------------ */
/* Cost report contract                                               */
/* ------------------------------------------------------------------ */

export interface ParserCostReportV1 {
  sourcePages: number;
  profiledPages: number;
  pdfplumberPagesExecuted: number;
  pdfplumberPagesReused: number;
  camelotPagesExecuted: number;
  camelotPagesReused: number;
  doclingPagesExecuted: number;
  doclingPagesReused: number;
  paddleocrPagesExecuted: number;
  paddleocrPagesReused: number;
  llamaparsePagesExecuted: number;
  llamaparsePagesReused: number;
  providerCreditsUsed: number | null;
  paidPageCap: number;
  paidPagesRemaining: number;
  localRuntimeDurationsMillis: number;
  parserFailures: number;
  finalVerificationDecision: string;
}

/* ------------------------------------------------------------------ */
/* Cost accumulator                                                   */
/* ------------------------------------------------------------------ */

export class CostAccumulator {
  private sourcePages = 0;
  private profiledPages = 0;
  private executed: Record<ExtractionMethodV1, number> = {
    native_structured: 0,
    deterministic_pdfplumber: 0,
    camelot: 0,
    docling: 0,
    paddleocr: 0,
    llamaparse: 0,
    manual: 0,
  };
  private reused: Record<ExtractionMethodV1, number> = {
    native_structured: 0,
    deterministic_pdfplumber: 0,
    camelot: 0,
    docling: 0,
    paddleocr: 0,
    llamaparse: 0,
    manual: 0,
  };
  private providerCreditsUsed: number | null = null;
  private paidPageCap = 0;
  private localRuntimeDurationsMillis = 0;
  private parserFailures = 0;
  private finalVerificationDecision = '';

  setSourcePages(count: number): void {
    this.sourcePages = count;
  }

  setProfiledPages(count: number): void {
    this.profiledPages = count;
  }

  recordExecuted(method: ExtractionMethodV1, pages: number): void {
    this.executed[method] += pages;
  }

  recordReused(method: ExtractionMethodV1, pages: number): void {
    this.reused[method] += pages;
  }

  setProviderCreditsUsed(credits: number | null): void {
    this.providerCreditsUsed = credits;
  }

  setPaidPageCap(cap: number): void {
    this.paidPageCap = cap;
  }

  addLocalRuntimeMillis(ms: number): void {
    this.localRuntimeDurationsMillis += ms;
  }

  incrementParserFailures(): void {
    this.parserFailures++;
  }

  setFinalVerificationDecision(decision: string): void {
    this.finalVerificationDecision = decision;
  }

  buildReport(): ParserCostReportV1 {
    const paidPagesUsed =
      this.executed.llamaparse + this.reused.llamaparse;
    return {
      sourcePages: this.sourcePages,
      profiledPages: this.profiledPages,
      pdfplumberPagesExecuted: this.executed.deterministic_pdfplumber,
      pdfplumberPagesReused: this.reused.deterministic_pdfplumber,
      camelotPagesExecuted: this.executed.camelot,
      camelotPagesReused: this.reused.camelot,
      doclingPagesExecuted: this.executed.docling,
      doclingPagesReused: this.reused.docling,
      paddleocrPagesExecuted: this.executed.paddleocr,
      paddleocrPagesReused: this.reused.paddleocr,
      llamaparsePagesExecuted: this.executed.llamaparse,
      llamaparsePagesReused: this.reused.llamaparse,
      providerCreditsUsed: this.providerCreditsUsed,
      paidPageCap: this.paidPageCap,
      paidPagesRemaining: Math.max(0, this.paidPageCap - paidPagesUsed),
      localRuntimeDurationsMillis: this.localRuntimeDurationsMillis,
      parserFailures: this.parserFailures,
      finalVerificationDecision: this.finalVerificationDecision,
    };
  }
}