import fs from 'node:fs';

const file = 'packages/meriv2-core/src/compliance/compliance-rules.spec.ts';
let source = fs.readFileSync(file, 'utf8');
const oldBlock = `  it('pre-approves internal artifacts + task bookkeeping (PASS, audited)', () => {\n    for (const tool of [\n      'save_note',\n      'save_memory',\n      'confirm_memory',\n      'correct_memory',\n      'forget_memory',\n      'create_word',\n      'create_excel',\n      'create_powerpoint',\n      'create_meeting_brief',\n      'draft_policy_memo',\n    ]) {\n      const d = decide(policy, tool);\n      expect(d.outcome).toBe('PASS');\n      expect(d.ruleId).toBe('internal_artifacts.pass');\n    }\n  });\n`;
const newBlock = `  it('pre-approves internal artifacts + task bookkeeping (PASS, audited)', () => {\n    for (const tool of [\n      'save_note',\n      'save_memory',\n      'create_word',\n      'create_excel',\n      'create_powerpoint',\n      'create_meeting_brief',\n      'draft_policy_memo',\n    ]) {\n      const d = decide(policy, tool);\n      expect(d.outcome).toBe('PASS');\n      expect(d.ruleId).toBe('internal_artifacts.pass');\n    }\n  });\n\n  it('does not unconditionally pre-approve scope-sensitive memory mutations', () => {\n    for (const tool of ['confirm_memory', 'correct_memory', 'forget_memory']) {\n      const d = decide(policy, tool);\n      expect(d.outcome).toBe('WARN');\n      expect(d.ruleId).toBeUndefined();\n    }\n  });\n`;
if (!source.includes(oldBlock)) throw new Error('compliance-rules.spec.ts anchor changed');
source = source.replace(oldBlock, newBlock);
fs.writeFileSync(file, source);
