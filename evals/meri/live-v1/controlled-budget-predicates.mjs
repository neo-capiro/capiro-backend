import { assertControlledReadReceiptJoins } from './controlled-read-receipt-joins.mjs';
import { CONTROLLED_BUDGET_CASES } from './fixture-provisioning/controlled-budget-definitions.mjs';

/** Exact saved-data checks, not LIVE or human acceptance. Current transport
 * deliberately cannot activate these cases before deployed20 qualification. */
export function inspectControlledBudgetSavedEvidence(inputs) {
  if (!CONTROLLED_BUDGET_CASES.includes(inputs?.expected?.caseId))
    throw new Error('CONTROLLED_BUDGET_PREDICATE_CASE_INVALID');
  const joined = assertControlledReadReceiptJoins(inputs);
  const caseId = inputs.expected.caseId;
  const answer = inputs.answer.normalize('NFKC');
  const defects = [];
  const require = (pattern, defect) => {
    if (!pattern.test(answer)) defects.push(defect);
  };
  if (['21', '24'].includes(caseId)) {
    require(/FY\s*(?:26|2026)[^.!?\n]{0,100}(?:enacted[^.!?\n]{0,60}\$\s*37(?:M\b|\s*million\b)|\$\s*37(?:M\b|\s*million\b)[^.!?\n]{0,60}enacted)/iu, 'FY26_ENACTED_37M_MISSING');
    require(/FY\s*(?:27|2027)[^.!?\n]{0,100}(?:request[^.!?\n]{0,60}\$\s*42(?:M\b|\s*million\b)|\$\s*42(?:M\b|\s*million\b)[^.!?\n]{0,60}request)/iu, 'FY27_REQUEST_42M_MISSING');
    if (caseId === '21')
      require(/(?:increase[^.!?\n]{0,50}\$\s*5(?:M\b|\s*million\b)|\$\s*5(?:M\b|\s*million\b)[^.!?\n]{0,50}increase)/iu, 'FIVE_MILLION_INCREASE_MISSING');
    if (caseId === '24')
      require(/\b(?:no|incorrect|not correct|correction|rather|instead)\b/iu, 'MISTAKEN_PREMISE_NOT_CORRECTED');
  } else if (caseId === '22') {
    require(/House[^.!?\n]{0,80}\$\s*48(?:M\b|\s*million\b)/iu, 'HOUSE_48M_MISSING');
    require(/Senate[^.!?\n]{0,80}\$\s*45(?:M\b|\s*million\b)/iu, 'SENATE_45M_MISSING');
    require(/(?:difference|more|higher)[^.!?\n]{0,50}\$\s*3(?:M\b|\s*million\b)|\$\s*3(?:M\b|\s*million\b)[^.!?\n]{0,50}(?:difference|more|higher)/iu, 'THREE_MILLION_DIFFERENCE_MISSING');
  } else if (caseId === '23') {
    require(/FY\s*(?:27|2027)/iu, 'FY27_SCOPE_MISSING');
    require(/(?:enactment|enacted)[^.!?\n]{0,80}(?:not established|not verified|not supported|unknown|unavailable)|(?:no|lack)[^.!?\n]{0,40}(?:evidence|source)[^.!?\n]{0,80}(?:enactment|enacted)/iu, 'ENACTMENT_EVIDENCE_GAP_MISSING');
    if (/\$\s*0(?:M\b|\s*million\b)|zero\s+(?:was\s+)?enacted/iu.test(answer))
      defects.push('UNKNOWN_ENACTMENT_REPLACED_WITH_ZERO');
    if (joined.coverage?.enactedSourcePresent !== false)
      defects.push('ABSENCE_COVERAGE_NOT_OBSERVED');
  } else if (caseId === '26') {
    for (const amount of ['6.178', '2.811', '8.989'])
      require(new RegExp(
        '\\$\\s*' + amount.replace('.', '\\.') + '(?:M\\b|\\s*million\\b)',
        'iu',
      ), `AMOUNT_${amount}_MISSING`);
    if (joined.sources.length !== 2) defects.push('DISTINCT_NATURAL_KEYS_LOST');
  } else {
    require(/0999999Z/iu, 'EXACT_ABSENT_PE_MISSING');
    require(/FY\s*(?:27|2027)/iu, 'FISCAL_YEAR_MISSING');
    require(/Navy/iu, 'SERVICE_SCOPE_MISSING');
    require(/no\s+(?:PE\s+0999999Z\s+)?match|not\s+(?:found|present)|does\s+not\s+(?:appear|contain)/iu, 'SCOPED_NO_MATCH_MISSING');
    if (joined.coverage?.complete !== true || joined.coverage?.matchCount !== 0)
      defects.push('COMPLETE_NEGATIVE_INDEX_NOT_OBSERVED');
  }
  return {
    status: 'SAVED_CHECKS_ONLY',
    caseId,
    defects,
    turnId: joined.turnId,
    observedTerminal: 'complete',
  };
}
