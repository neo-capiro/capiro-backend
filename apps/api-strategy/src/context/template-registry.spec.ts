import { describe, expect, it } from '@jest/globals';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  DOCUMENT_TYPES,
  OPERATIONAL_REPORT_TEMPLATE_KEYS,
  REPORT_PREFIX_FALLBACKS,
  REPORT_SECTION_ORDER,
  REPORT_SECTION_TITLES,
  TEMPLATE_KEY_BY_TYPE,
  isOperationalReportTemplate,
  reportFallbackSection,
} from './template-registry.js';

const PREFIX_CASES = [
  ['01_', 'situation'],
  ['02_', 'constraints'],
  ['06_', 'constraints'],
  ['03_', 'ask'],
  ['04_', 'stakeholders'],
  ['05_', 'timing'],
  ['08_', 'evidence'],
  ['09_', 'intelligence'],
  ['10_', 'decisions'],
] as const;
const OPERATIONAL = [
  '00_context_manifest',
  '07_current_plan',
  '11_agent_mission',
  '12_execution_playbook',
  '13_agent_permissions',
];

describe('canonical Strategy template metadata', () => {
  it('retains the ordered seventeen-type contract and every real template filename', () => {
    const files = readdirSync(join(__dirname, 'templates'))
      .filter((file) => /^\d{2}_.*\.md$/.test(file))
      .sort();
    expect(DOCUMENT_TYPES).toHaveLength(17);
    expect(Object.keys(TEMPLATE_KEY_BY_TYPE)).toEqual(DOCUMENT_TYPES);
    expect(DOCUMENT_TYPES.map((type) => TEMPLATE_KEY_BY_TYPE[type])).toEqual(
      files.map((file) => file.replace(/\.md$/, '')),
    );
    expect(Object.isFrozen(DOCUMENT_TYPES)).toBe(false);
    expect(Object.isFrozen(TEMPLATE_KEY_BY_TYPE)).toBe(false);
    expect(Object.getPrototypeOf(TEMPLATE_KEY_BY_TYPE)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(TEMPLATE_KEY_BY_TYPE, '__proto__')).toBe(false);
  });

  it('keeps the title-record order distinct from the report output order', () => {
    expect(Object.entries(REPORT_SECTION_TITLES)).toEqual([
      ['situation', 'Situation and stakes'],
      ['outcomes', 'Objectives and definition of success'],
      ['ask', 'Strategic ask and options'],
      ['stakeholders', 'Stakeholder landscape'],
      ['constraints', 'Constraints and decision rules'],
      ['timing', 'Timing and external windows'],
      ['evidence', 'Evidence and assumptions'],
      ['decisions', 'Decisions and commitments'],
      ['intelligence', 'Recent intelligence'],
      ['governance', 'Internal operating guidance'],
    ]);
    expect(REPORT_SECTION_ORDER).toEqual([
      'situation',
      'outcomes',
      'ask',
      'stakeholders',
      'constraints',
      'timing',
      'decisions',
      'intelligence',
      'evidence',
      'governance',
    ]);
    expect(Object.keys(REPORT_SECTION_TITLES)).not.toEqual(REPORT_SECTION_ORDER);
  });

  it('retains all nine prefix rows in their original evaluation order', () => {
    expect(REPORT_PREFIX_FALLBACKS.map(({ prefix, section }) => [prefix, section])).toEqual(
      PREFIX_CASES,
    );
    const visited: string[] = [];
    const key = {
      startsWith(prefix: string) {
        visited.push(prefix);
        return false;
      },
    } as unknown as string;
    expect(reportFallbackSection(key)).toBe('governance');
    expect(visited).toEqual(PREFIX_CASES.map(([prefix]) => prefix));
  });

  it.each(PREFIX_CASES.map(([prefix, section]) => ({ prefix, section })))(
    'routes an unknown $prefix suffix to $section without requiring a known key',
    ({ prefix, section }) => {
      expect(reportFallbackSection(`${prefix}unknown_future_template`)).toBe(section);
    },
  );

  it.each([
    '14_custom',
    '15_custom',
    '16_custom',
    '01',
    '',
    '__proto__',
    'constructor',
    'toString',
    ' 01_custom',
  ])('%s keeps the governance fallback', (key) => {
    expect(reportFallbackSection(key)).toBe('governance');
  });

  it.each([null, undefined, 12, {}, ['01_custom']])(
    'does not coerce malformed prefix input %p',
    (key) => {
      expect(() => reportFallbackSection(key as unknown as string)).toThrow(TypeError);
    },
  );

  it('keeps operational membership exact instead of applying prefix or whitespace normalization', () => {
    expect([...OPERATIONAL_REPORT_TEMPLATE_KEYS]).toEqual(OPERATIONAL);
    for (const key of OPERATIONAL) {
      expect(isOperationalReportTemplate(key)).toBe(true);
      expect(isOperationalReportTemplate(`${key}_extra`)).toBe(false);
      expect(isOperationalReportTemplate(` ${key}`)).toBe(false);
      expect(isOperationalReportTemplate(key.toUpperCase())).toBe(false);
    }
    for (const key of [null, undefined, {}, ['00_context_manifest'], '__proto__', 'constructor']) {
      expect(isOperationalReportTemplate(key as unknown as string)).toBe(false);
    }
  });
});
