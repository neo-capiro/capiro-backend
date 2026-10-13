/** Independent expected metadata and source text; no classifier or selector logic. */
export const expectedClasses = {
  enacted: {
    changeType: 'bill_enacted',
    triggerKey: 'enactedFailed',
    label: 'Became law',
    tone: 'success',
    severity: 'critical',
  },
  president: {
    changeType: 'bill_to_president',
    triggerKey: 'enactedFailed',
    label: 'Sent to President',
    tone: 'success',
    severity: 'critical',
  },
  failed: {
    changeType: 'bill_failed',
    triggerKey: 'enactedFailed',
    label: 'Failed / rejected',
    tone: 'critical',
    severity: 'critical',
  },
  passed: {
    changeType: 'bill_passed_chamber',
    triggerKey: 'floorVote',
    label: 'Passed a chamber',
    tone: 'success',
    severity: 'notable',
  },
  rule: {
    changeType: 'bill_rule_reported',
    triggerKey: 'floorVote',
    label: 'Rule granted (floor scheduled)',
    tone: 'info',
    severity: 'notable',
  },
  floor: {
    changeType: 'bill_floor_scheduled',
    triggerKey: 'floorVote',
    label: 'Floor action scheduled',
    tone: 'info',
    severity: 'notable',
  },
  reported: {
    changeType: 'bill_reported',
    triggerKey: 'committeeVote',
    label: 'Passed committee',
    tone: 'success',
    severity: 'notable',
  },
  markup: {
    changeType: 'bill_markup',
    triggerKey: 'committeeVote',
    label: 'Markup',
    tone: 'info',
    severity: 'notable',
  },
  hearing: {
    changeType: 'bill_hearing',
    triggerKey: 'hearing',
    label: 'Hearing scheduled',
    tone: 'info',
    severity: 'info',
  },
  amendment: {
    changeType: 'bill_amendment',
    triggerKey: 'amendment',
    label: 'Amended',
    tone: 'notable',
    severity: 'notable',
  },
} as const;

export const classificationCases: ReadonlyArray<{
  name: string;
  text: string | null;
  expected: keyof typeof expectedClasses | null;
}> = [
  { name: 'enactment metadata', text: 'SIGNED BY THE PRESIDENT.', expected: 'enacted' },
  {
    name: 'presidential presentment metadata',
    text: 'Cleared for White House.',
    expected: 'president',
  },
  {
    name: 'measure failure metadata',
    text: 'On passage rejected by recorded vote.',
    expected: 'failed',
  },
  { name: 'chamber passage metadata', text: 'Passed/agreed to in the Senate.', expected: 'passed' },
  {
    name: 'rule metadata uses floorVote',
    text: 'Committee on Rules reported favorably.',
    expected: 'rule',
  },
  { name: 'floor schedule metadata', text: 'Placed on the Senate calendar.', expected: 'floor' },
  {
    name: 'committee report metadata',
    text: 'Committee agreed to seek consideration.',
    expected: 'reported',
  },
  {
    name: 'markup metadata',
    text: 'Committee consideration and mark-up session.',
    expected: 'markup',
  },
  { name: 'hearing metadata', text: 'Subcommittee hearing held.', expected: 'hearing' },
  { name: 'amendment metadata', text: 'Substitute offered.', expected: 'amendment' },
  { name: 'null action is routine', text: null, expected: null },
  { name: 'empty action is routine', text: '', expected: null },
  { name: 'whitespace action is routine', text: ' \t\n ', expected: null },
  { name: 'introduction is routine', text: 'Introduced in House.', expected: null },
  { name: 'committee referral is routine', text: 'Referred to the committee.', expected: null },
  { name: 'recommit failure is procedural', text: 'Motion to recommit failed.', expected: null },
  { name: 'cloture rejection is procedural', text: 'Cloture motion rejected.', expected: null },
  { name: 'ambiguous tabling is procedural', text: 'Motion to table agreed to.', expected: null },
  {
    name: 'failed amendment stays amendment',
    text: 'Amendment SA 2 failed of adoption.',
    expected: 'amendment',
  },
  {
    name: 'veto threat does not defeat passage',
    text: 'Passed House amid a veto threat.',
    expected: 'passed',
  },
  { name: 'actual veto is measure failure', text: 'Veto message received.', expected: 'failed' },
  {
    name: 'enactment precedes presentment',
    text: 'Presented to President; became law.',
    expected: 'enacted',
  },
  {
    name: 'presentment precedes failure',
    text: 'Presented to President; failed of passage.',
    expected: 'president',
  },
  {
    name: 'failure precedes passage',
    text: 'Failed of passage; passed the House.',
    expected: 'failed',
  },
  {
    name: 'passage precedes rule',
    text: 'Passed the House under a closed rule.',
    expected: 'passed',
  },
  {
    name: 'rule precedes floor schedule',
    text: 'Special rule; scheduled for floor.',
    expected: 'rule',
  },
  {
    name: 'floor schedule precedes report',
    text: 'Scheduled for floor; reported favorably.',
    expected: 'floor',
  },
  {
    name: 'report precedes markup',
    text: 'Reported favorably after markup.',
    expected: 'reported',
  },
  { name: 'markup precedes hearing', text: 'Markup after a hearing.', expected: 'markup' },
  { name: 'hearing precedes amendment', text: 'Hearing on an amendment.', expected: 'hearing' },
];
