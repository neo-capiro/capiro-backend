export type EvalCategory = 'leakage' | 'grounding';

export interface EvalOutcome {
  pass: boolean;
  detail: string;
}

export interface EvalCase {
  id: string;
  category: EvalCategory;
  description: string;
  run(): Promise<EvalOutcome>;
}
