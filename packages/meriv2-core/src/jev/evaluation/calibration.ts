import type { EvidenceOutcome } from '../decision-contract';

export interface CalibrationRow {
  split: 'tuning' | 'heldout' | null;
  task: string;
  questionVersion: string;
  model: string;
  confidence: number;
  predicted: EvidenceOutcome;
  label: EvidenceOutcome | null;
}

function metrics(rows: readonly CalibrationRow[], threshold: number) {
  const labeled = rows.filter((row) => row.label !== null);
  const accepted = labeled.filter((row) => row.confidence >= threshold);
  const correct = accepted.filter((row) => row.predicted === row.label).length;
  const allCorrect = labeled.filter((row) => row.predicted === row.label).length;
  return {
    threshold,
    rows: labeled.length,
    accepted: accepted.length,
    precision: accepted.length ? correct / accepted.length : null,
    recall: allCorrect ? correct / allCorrect : null,
    coverage: labeled.length ? accepted.length / labeled.length : null,
  };
}

export function evaluateThresholds(input: {
  rows: readonly CalibrationRow[];
  task: string;
  questionVersion: string;
  model: string;
  thresholds: number[];
  chosenThreshold?: number;
}) {
  if (input.thresholds.some((threshold) => threshold < 0 || threshold > 1)) {
    throw new Error('Thresholds must be between 0 and 1');
  }
  const scoped = input.rows.filter((row) => row.task === input.task);
  const versions = [...new Set(scoped.map((row) => row.questionVersion))].sort();
  const models = [...new Set(scoped.map((row) => row.model))].sort();
  if (versions.some((value) => value !== input.questionVersion) || models.some((value) => value !== input.model)) {
    throw new Error(`Calibration refuses mixed scope; question versions [${versions.join(', ')}], models [${models.join(', ')}]`);
  }
  const tuning = scoped.filter((row) => row.split === 'tuning');
  const heldout = scoped.filter((row) => row.split === 'heldout');
  const candidates = [...new Set(input.thresholds)].sort((a, b) => a - b).map((threshold) => metrics(tuning, threshold));
  const chosenThreshold = input.chosenThreshold;
  return {
    reportVersion: 'jev_threshold_calibration_v1' as const,
    task: input.task,
    questionVersion: input.questionVersion,
    model: input.model,
    validity: 'Thresholds are valid only for this task, question version, and model triple.',
    selection: 'No threshold is selected by code; candidates are listed from tuning rows only.',
    candidates,
    heldout: chosenThreshold === undefined ? null : metrics(heldout, chosenThreshold),
  };
}
