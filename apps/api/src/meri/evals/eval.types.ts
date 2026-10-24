/**
 * Meri eval harness types (P1-1).
 *
 * An "eval fixture" is a committed Q&A item: a question, optional inline sources
 * (so grounding can be graded without live retrieval/DB), and the expectations a
 * correct answer must satisfy. The runner (`pnpm eval:clio`) sends each fixture
 * through the real Meri model path and grades the answer with the pure grader in
 * eval-grader.ts; grounded-rate reuses the P0-6 verifier helpers.
 *
 * Fixtures are scoped by `skill` (briefing / draft / research / general /
 * citation / refusal / …) so eval results can be read per skill.
 */
import { z } from 'zod';

export const meriEvalSourceSchema = z.object({
  /** Citation marker number the answer should use ([id]). */
  id: z.number().int().positive(),
  title: z.string().min(1),
  text: z.string().min(1),
});

export const meriEvalExpectSchema = z.object({
  /** Case-insensitive substrings the answer MUST contain. */
  mustInclude: z.array(z.string()).default([]),
  /** Case-insensitive substrings the answer must NOT contain (hallucination / safety guards). */
  mustNotInclude: z.array(z.string()).default([]),
  /** Require at least one inline [n] citation marker. */
  mustCite: z.boolean().default(false),
  /**
   * Max allowed share of unsupported claims (verifier). Only enforced on the live
   * run when sources are present. Defaults applied by the runner when omitted.
   */
  maxUnsupportedRatio: z.number().min(0).max(1).optional(),
});

export const meriEvalFixtureSchema = z.object({
  id: z.string().min(1),
  /** Skill bucket, e.g. 'briefing' | 'draft' | 'research' | 'general' | 'citation' | 'refusal'. */
  skill: z.string().min(1),
  question: z.string().min(1),
  /** Inline sources the answer should ground against (empty for open Q&A / refusals). */
  sources: z.array(meriEvalSourceSchema).default([]),
  expect: meriEvalExpectSchema.prefault({}),
});

export const meriEvalFixturesSchema = z.array(meriEvalFixtureSchema);

export type MeriEvalSource = z.infer<typeof meriEvalSourceSchema>;
export type MeriEvalExpect = z.infer<typeof meriEvalExpectSchema>;
export type MeriEvalFixture = z.infer<typeof meriEvalFixtureSchema>;
/** Authoring shape: defaulted fields (sources/expect/*) are optional pre-parse. */
export type MeriEvalFixtureInput = z.input<typeof meriEvalFixtureSchema>;

/** Per-fixture grade produced by the grader. */
export interface MeriEvalGrade {
  id: string;
  skill: string;
  pass: boolean;
  /** Human-readable reasons the fixture failed (empty when pass). */
  failures: string[];
  /** Distinct [n] citation markers found in the answer. */
  citationCount: number;
  /** Unsupported-claim ratio from the verifier; null when not verified. */
  unsupportedRatio: number | null;
}

export interface MeriEvalSkillStat {
  total: number;
  passed: number;
}

export interface MeriEvalSummary {
  total: number;
  passed: number;
  failed: number;
  passRate: number;
  /** Share of *verified* fixtures whose unsupported ratio is within threshold. 1 when none verified. */
  groundedRate: number;
  verifiedCount: number;
  bySkill: Record<string, MeriEvalSkillStat>;
}
