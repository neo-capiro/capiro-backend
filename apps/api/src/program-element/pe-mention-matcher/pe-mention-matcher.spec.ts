import {
  aggregateMentionsByPe,
  buildNameBank,
  extractDesignatorTerms,
  extractSnippet,
  findMentions,
  isDesignatorToken,
  isTermAcceptable,
  matchBillTitles,
  mentionDedupeKey,
  mentionSeverity,
  normalizeTerm,
  SNIPPET_RADIUS,
  TERM_STOPLIST,
  TIER_CONFIDENCE,
  type NameBankEntryInput,
} from './pe-mention-matcher.js';

// ─────────────────────────────────────────────────────────────────────────
// Shared fixture bank. Mix of realistic program names, capability aliases and
// PE titles, PLUS inputs the quality gate must reject (short acronyms, generic
// single words, stoplist boilerplate). PE codes are fixture values in the real
// code shape. 'hypersonic glide body' intentionally maps to TWO PEs (a shared
// capability alias) and 0604182A carries both a program name and that alias.
// ─────────────────────────────────────────────────────────────────────────
const BANK_INPUT: NameBankEntryInput[] = [
  // accepted
  { peCode: '0207820F', term: 'Collaborative Combat Aircraft', tier: 'program_name' },
  { peCode: '0207110F', term: 'Next Generation Air Dominance', tier: 'program_name' },
  { peCode: '0604182A', term: 'Long Range Hypersonic Weapon', tier: 'program_name' },
  { peCode: '0205219F', term: 'MQ-9 Reaper', tier: 'program_name' },
  { peCode: '0207142F', term: 'F-35A', tier: 'program_name' }, // single token, designator, len 5
  { peCode: '0604182A', term: 'hypersonic glide body', tier: 'capability_alias' },
  { peCode: '0603286E', term: 'hypersonic glide body', tier: 'capability_alias' },
  { peCode: '0604741A', term: 'counter-unmanned aircraft systems', tier: 'capability_alias' },
  { peCode: '0604123A', term: 'GPS-denied navigation', tier: 'capability_alias' },
  { peCode: '0603286E', term: 'Advanced Aerospace Systems', tier: 'pe_title' },
  { peCode: '0603180C', term: 'Ballistic Missile Defense Sensors', tier: 'pe_title' },
  // must be rejected by the quality gate / stoplist
  { peCode: '0207142F', term: 'F-35', tier: 'program_name' }, // len 4 — too risky
  { peCode: '0207820F', term: 'CCA', tier: 'program_name' }, // bare acronym
  { peCode: '0207820F', term: 'Sentinel', tier: 'program_name' }, // 1 word, no designator
  { peCode: '0111111F', term: 'aircraft', tier: 'pe_title' }, // generic single word
  { peCode: '0222222A', term: 'munitions', tier: 'capability_alias' }, // generic single word
  { peCode: '0333333N', term: 'Hypersonics', tier: 'pe_title' }, // single word, wrong tier for exception
  { peCode: '0444444D', term: 'Research and Development', tier: 'pe_title' }, // stoplist
  { peCode: '0555555D', term: 'Program Element', tier: 'pe_title' }, // stoplist
];

const bank = buildNameBank(BANK_INPUT);

// ─────────────────────────────────────────────────────────────────────────
// Golden fixtures: realistic transcript snippets. `expect` lists the
// (peCode, term, occurrences) tuples findMentions must produce — [] means the
// text must produce NO mentions at all (hard negatives).
// ─────────────────────────────────────────────────────────────────────────
interface GoldenCase {
  name: string;
  text: string;
  expect: Array<{ peCode: string; term: string; occurrences: number }>;
}

const GOLDEN_FIXTURES: GoldenCase[] = [
  // ── positives ──────────────────────────────────────────────────────────
  {
    name: 'program name in a posture statement',
    text: 'General Allvin testified that the Collaborative Combat Aircraft program will deliver Increment 1 operational capability by fiscal year 2027, contingent on stable funding.',
    expect: [{ peCode: '0207820F', term: 'Collaborative Combat Aircraft', occurrences: 1 }],
  },
  {
    name: 'case-insensitive matching',
    text: 'Members pressed the witness on whether the collaborative combat aircraft effort duplicates existing unmanned programs.',
    expect: [{ peCode: '0207820F', term: 'Collaborative Combat Aircraft', occurrences: 1 }],
  },
  {
    name: 'multiple occurrences counted',
    text: 'The Collaborative Combat Aircraft budget request doubles this year. Critics argue the Collaborative Combat Aircraft schedule is optimistic.',
    expect: [{ peCode: '0207820F', term: 'Collaborative Combat Aircraft', occurrences: 2 }],
  },
  {
    name: 'Army hypersonics program name',
    text: 'The Long Range Hypersonic Weapon achieved a successful end-to-end flight test at Cape Canaveral in December.',
    expect: [{ peCode: '0604182A', term: 'Long Range Hypersonic Weapon', occurrences: 1 }],
  },
  {
    name: 'NGAD family-of-systems phrasing',
    text: 'Regarding the Next Generation Air Dominance family of systems, the Secretary deferred to the classified session.',
    expect: [{ peCode: '0207110F', term: 'Next Generation Air Dominance', occurrences: 1 }],
  },
  {
    name: 'designator program name followed by punctuation',
    text: 'The wing operated the MQ-9 Reaper, alongside contractor-owned platforms, throughout the deployment.',
    expect: [{ peCode: '0205219F', term: 'MQ-9 Reaper', occurrences: 1 }],
  },
  {
    name: 'single-token designator program name (F-35A)',
    text: 'The committee directed a report on F-35A sustainment costs per tail per year.',
    expect: [{ peCode: '0207142F', term: 'F-35A', occurrences: 1 }],
  },
  {
    name: 'pe_title tier match',
    text: 'The budget increases funding for Advanced Aerospace Systems within the agency research portfolio.',
    expect: [{ peCode: '0603286E', term: 'Advanced Aerospace Systems', occurrences: 1 }],
  },
  {
    name: 'capability alias fans out to every mapped PE',
    text: 'Industrial-base witnesses cited hypersonic glide body production capacity as the pacing constraint.',
    expect: [
      { peCode: '0603286E', term: 'hypersonic glide body', occurrences: 1 },
      { peCode: '0604182A', term: 'hypersonic glide body', occurrences: 1 },
    ],
  },
  {
    name: 'hyphenated capability alias',
    text: 'The roadmap prioritizes GPS-denied navigation for contested environments.',
    expect: [{ peCode: '0604123A', term: 'GPS-denied navigation', occurrences: 1 }],
  },
  {
    name: 'term at the very start of the text',
    text: 'Collaborative Combat Aircraft funding is the top unfunded priority this cycle.',
    expect: [{ peCode: '0207820F', term: 'Collaborative Combat Aircraft', occurrences: 1 }],
  },
  {
    name: 'term at the very end of the text',
    text: 'For the record, this subcommittee fully supports the Long Range Hypersonic Weapon',
    expect: [{ peCode: '0604182A', term: 'Long Range Hypersonic Weapon', occurrences: 1 }],
  },
  {
    name: 'two different programs in one exchange',
    text: 'Unlike the Next Generation Air Dominance platform, the Collaborative Combat Aircraft is designed for attritable mass.',
    expect: [
      { peCode: '0207110F', term: 'Next Generation Air Dominance', occurrences: 1 },
      { peCode: '0207820F', term: 'Collaborative Combat Aircraft', occurrences: 1 },
    ],
  },
  {
    name: 'program name and shared-PE alias in the same transcript',
    text: 'The Long Range Hypersonic Weapon battery is fielded; the common hypersonic glide body remains the limiting factor.',
    expect: [
      { peCode: '0603286E', term: 'hypersonic glide body', occurrences: 1 },
      { peCode: '0604182A', term: 'Long Range Hypersonic Weapon', occurrences: 1 },
      { peCode: '0604182A', term: 'hypersonic glide body', occurrences: 1 },
    ],
  },
  // ── hard negatives (must produce NO mentions) ──────────────────────────
  {
    name: 'NEGATIVE: term embedded in a longer word (suffix continues)',
    text: 'The manual covers GPS-denied navigational aids for rotary-wing crews.',
    expect: [],
  },
  {
    name: 'NEGATIVE: term embedded in a longer word (prefix attached)',
    text: 'Panelists dismissed the antihypersonic glide body concept as unfunded.',
    expect: [],
  },
  {
    name: 'NEGATIVE: stoplist boilerplate never matches',
    text: 'The research and development account funds every program element reviewed by the committee on armed services.',
    expect: [],
  },
  {
    name: 'NEGATIVE: generic single words rejected at bank build',
    text: 'Witnesses discussed aircraft availability and munitions stockpiles across all theaters.',
    expect: [],
  },
  {
    name: 'NEGATIVE: short acronym and short designator rejected at bank build',
    text: 'The CCA program office briefed F-35 sustainment metrics to the panel.',
    expect: [],
  },
  {
    name: 'NEGATIVE: partial phrase does not match the full program name',
    text: 'The doctrine emphasizes collaborative combat operations across all domains.',
    expect: [],
  },
  {
    name: 'NEGATIVE: whole-word rule means plural form does not match',
    text: 'The squadron flies MQ-9 Reapers on rotational deployments.',
    expect: [],
  },
];

describe('pe-mention-matcher', () => {
  describe('golden fixtures (findMentions over the fixture bank)', () => {
    it('carries at least 20 fixture cases incl. at least 6 hard negatives', () => {
      expect(GOLDEN_FIXTURES.length).toBeGreaterThanOrEqual(20);
      expect(GOLDEN_FIXTURES.filter((c) => c.expect.length === 0).length).toBeGreaterThanOrEqual(6);
    });

    it.each(GOLDEN_FIXTURES.map((c) => [c.name, c] as const))('%s', (_name, c) => {
      const mentions = findMentions(c.text, bank);
      const actual = mentions
        .map((m) => ({ peCode: m.peCode, term: m.term, occurrences: m.occurrences }))
        .sort((a, b) => a.peCode.localeCompare(b.peCode) || a.term.localeCompare(b.term));
      const expected = [...c.expect].sort(
        (a, b) => a.peCode.localeCompare(b.peCode) || a.term.localeCompare(b.term),
      );
      expect(actual).toEqual(expected);
    });

    it('every mention carries tier-derived confidence and a snippet containing the term', () => {
      const text =
        'The Long Range Hypersonic Weapon test succeeded. Separately, hypersonic glide body output doubled.';
      const mentions = findMentions(text, bank);
      const program = mentions.find((m) => m.term === 'Long Range Hypersonic Weapon');
      const alias = mentions.find(
        (m) => m.term === 'hypersonic glide body' && m.peCode === '0604182A',
      );
      expect(program?.confidence).toBe(TIER_CONFIDENCE.program_name);
      expect(program?.tier).toBe('program_name');
      expect(alias?.confidence).toBe(TIER_CONFIDENCE.capability_alias);
      expect(program?.snippet.toLowerCase()).toContain('long range hypersonic weapon');
      expect(alias?.snippet.toLowerCase()).toContain('hypersonic glide body');
    });

    it('reports firstIndex of the first whole-word occurrence', () => {
      const text = 'Prefix words here. Collaborative Combat Aircraft is discussed.';
      const mention = findMentions(text, bank)[0]!;
      expect(mention.firstIndex).toBe(text.indexOf('Collaborative'));
    });
  });

  describe('term normalization + quality gate', () => {
    it('normalizeTerm trims and collapses internal whitespace/newlines', () => {
      expect(normalizeTerm('  Long  Range \n Hypersonic\tWeapon ')).toBe(
        'Long Range Hypersonic Weapon',
      );
    });

    it.each([
      // [term, tier, accepted]
      ['Collaborative Combat Aircraft', 'program_name', true],
      ['MQ-9 Reaper', 'program_name', true],
      ['F-35A', 'program_name', true], // ≥5 + designator pattern
      ['B-21 Raider', 'program_name', true],
      ['F-35', 'program_name', false], // < 5 chars
      ['CCA', 'program_name', false], // bare acronym
      ['Sentinel', 'program_name', false], // 1 word, no designator
      ['aircraft', 'pe_title', false], // generic single word
      ['munitions', 'capability_alias', false],
      ['Hypersonics', 'pe_title', false], // single word — exception is program_name-only
      ['GPS-denied', 'capability_alias', false], // hyphenated but single whitespace token
      ['hypersonic glide body', 'capability_alias', true],
      ['research and development', 'pe_title', false], // stoplist
      ['Program Element', 'pe_title', false], // stoplist, case-insensitive
      ['Senate Armed Services Committee', 'pe_title', false], // stoplist committee name
    ] as Array<[string, 'program_name' | 'capability_alias' | 'pe_title', boolean]>)(
      '"%s" (%s) -> accepted=%s',
      (term, tier, accepted) => {
        expect(isTermAcceptable(normalizeTerm(term), tier)).toBe(accepted);
      },
    );

    it('stoplist entries are lowercase (lookup contract)', () => {
      for (const entry of TERM_STOPLIST) expect(entry).toBe(entry.toLowerCase());
    });
  });

  describe('buildNameBank', () => {
    it('counts rejected inputs and keeps accepted (term, peCode) pairs', () => {
      // 8 rejected: F-35, CCA, Sentinel, aircraft, munitions, Hypersonics,
      // Research and Development, Program Element.
      expect(bank.rejectedCount).toBe(8);
      expect(bank.entries.length).toBe(BANK_INPUT.length - 8);
    });

    it('keeps the highest-confidence tier when the same (term, peCode) repeats', () => {
      const dup = buildNameBank([
        { peCode: '0604182A', term: 'Long Range Hypersonic Weapon', tier: 'pe_title' },
        { peCode: '0604182A', term: 'long range hypersonic weapon', tier: 'program_name' },
      ]);
      expect(dup.entries).toHaveLength(1);
      expect(dup.entries[0]!.tier).toBe('program_name');
      expect(dup.entries[0]!.confidence).toBe(TIER_CONFIDENCE.program_name);
    });

    it('one term mapping multiple PEs keeps every pair', () => {
      const list = bank.byTermLower.get('hypersonic glide body');
      expect(list?.map((e) => e.peCode).sort()).toEqual(['0603286E', '0604182A']);
    });

    it('drops rows with empty term or peCode', () => {
      const b = buildNameBank([
        { peCode: '', term: 'Collaborative Combat Aircraft', tier: 'program_name' },
        { peCode: '0207820F', term: '   ', tier: 'program_name' },
      ]);
      expect(b.entries).toHaveLength(0);
      expect(b.rejectedCount).toBe(2);
    });
  });

  describe('snippet extraction', () => {
    it('collapses newlines to a single line and bounds the window to ±radius', () => {
      const pad = 'lorem ipsum dolor sit amet\nconsectetur adipiscing elit sed do\n'.repeat(20);
      const text = `${pad}The Collaborative Combat Aircraft program review.\n${pad}`;
      const mention = findMentions(text, bank)[0]!;
      expect(mention.snippet).not.toMatch(/[\r\n\t]/);
      expect(mention.snippet).toContain('Collaborative Combat Aircraft');
      // ±radius window + term + ellipses (collapse only shrinks)
      expect(mention.snippet.length).toBeLessThanOrEqual(
        2 * SNIPPET_RADIUS + 'Collaborative Combat Aircraft'.length + 2,
      );
      expect(mention.snippet.startsWith('…')).toBe(true);
      expect(mention.snippet.endsWith('…')).toBe(true);
    });

    it('omits ellipses when the text fits inside the window', () => {
      const snippet = extractSnippet('short text with a hit', 6, 4);
      expect(snippet).toBe('short text with a hit');
    });
  });

  describe('aggregateMentionsByPe + severity', () => {
    it('sums occurrences across terms and picks the highest-confidence representative', () => {
      const text =
        'The Long Range Hypersonic Weapon battery is fielded. The Long Range Hypersonic Weapon ' +
        'schedule holds, though hypersonic glide body production remains the constraint.';
      const summaries = aggregateMentionsByPe(findMentions(text, bank));
      const lrhw = summaries.find((s) => s.peCode === '0604182A');
      expect(lrhw?.occurrences).toBe(3); // 2× program name + 1× alias
      expect(lrhw?.matchedTerm).toBe('Long Range Hypersonic Weapon');
      expect(lrhw?.tier).toBe('program_name');
      expect(lrhw?.terms.sort()).toEqual(['Long Range Hypersonic Weapon', 'hypersonic glide body']);
      const darpa = summaries.find((s) => s.peCode === '0603286E');
      expect(darpa?.occurrences).toBe(1);
      expect(darpa?.matchedTerm).toBe('hypersonic glide body');
    });

    it('mentionSeverity: notable at >=3 distinct mentions, info below', () => {
      expect(mentionSeverity(1)).toBe('info');
      expect(mentionSeverity(2)).toBe('info');
      expect(mentionSeverity(3)).toBe('notable');
      expect(mentionSeverity(7)).toBe('notable');
    });

    it('mentionDedupeKey shape matches the freshness-layer contract', () => {
      expect(mentionDedupeKey('CHRG-119hhrg58001', '0207820F')).toBe(
        'mention:CHRG-119hhrg58001:0207820F',
      );
    });
  });

  describe('matchBillTitles', () => {
    it('matches a program name in a bill title with quoting evidence', () => {
      const candidates = matchBillTitles(
        [
          {
            billId: '119-hr-8100',
            title:
              'To accelerate procurement of the Collaborative Combat Aircraft, and for other purposes.',
          },
        ],
        bank,
      );
      expect(candidates).toHaveLength(1);
      expect(candidates[0]).toMatchObject({
        billId: '119-hr-8100',
        peCode: '0207820F',
        term: 'Collaborative Combat Aircraft',
        tier: 'program_name',
        confidence: TIER_CONFIDENCE.program_name,
      });
      expect(candidates[0]!.evidence).toContain('"Collaborative Combat Aircraft"');
      expect(candidates[0]!.evidence).toContain('To accelerate procurement');
    });

    it('excludes the pe_title tier from bill matching', () => {
      const candidates = matchBillTitles(
        [
          {
            billId: '119-s-2200',
            title: 'A bill to expand Advanced Aerospace Systems research at defense laboratories.',
          },
        ],
        bank,
      );
      expect(candidates).toEqual([]);
    });

    it('matches capability aliases and fans out to every mapped PE', () => {
      const candidates = matchBillTitles(
        [
          {
            billId: '119-hr-4400',
            title: 'Counter-Unmanned Aircraft Systems Improvement Act of 2026',
          },
          {
            billId: '119-s-9000',
            title: 'A bill to expand hypersonic glide body industrial capacity.',
          },
        ],
        bank,
      );
      expect(candidates.map((c) => `${c.billId}:${c.peCode}`).sort()).toEqual([
        '119-hr-4400:0604741A',
        '119-s-9000:0603286E',
        '119-s-9000:0604182A',
      ]);
      for (const c of candidates) expect(c.confidence).toBe(TIER_CONFIDENCE.capability_alias);
    });

    it('keeps one candidate per (bill, PE) preferring the higher-confidence term', () => {
      const candidates = matchBillTitles(
        [
          {
            billId: '119-hr-7777',
            title:
              'To fund the Long Range Hypersonic Weapon and hypersonic glide body production lines.',
          },
        ],
        bank,
      );
      const lrhw = candidates.filter((c) => c.peCode === '0604182A');
      expect(lrhw).toHaveLength(1);
      expect(lrhw[0]!.term).toBe('Long Range Hypersonic Weapon');
      expect(lrhw[0]!.tier).toBe('program_name');
      // The shared alias still links the OTHER PE it maps to.
      expect(candidates.some((c) => c.peCode === '0603286E')).toBe(true);
    });

    it('uses shortTitle when provided and labels the evidence accordingly', () => {
      const candidates = matchBillTitles(
        [
          {
            billId: '119-s-3300',
            title: 'An act making appropriations for military functions, and for other purposes.',
            shortTitle: 'MQ-9 Reaper Fleet Modernization Act',
          },
        ],
        bank,
      );
      expect(candidates).toHaveLength(1);
      expect(candidates[0]!.peCode).toBe('0205219F');
      expect(candidates[0]!.evidence).toContain('Bill short title matched');
    });

    it('returns nothing for unrelated titles', () => {
      const candidates = matchBillTitles(
        [{ billId: '119-hr-1', title: 'To rename a post office in Dayton, Ohio.' }],
        bank,
      );
      expect(candidates).toEqual([]);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // platform_designator tier — bare weapon-system designators pulled from PE
  // titles (F-35, B-21, CH-53K). The recall lever the enabled match-pe-mentions
  // rule needs: curated program names miss the corpus, designators hit it.
  // ───────────────────────────────────────────────────────────────────────
  describe('platform_designator tier', () => {
    describe('extractDesignatorTerms', () => {
      it.each([
        ['B-21 Raider Advance Procurement (CY) Forces', ['B-21']],
        ['CH-53K (Heavy Lift Replacement)', ['CH-53K']],
        ['AH-64 Apache Block IIIA Reman', ['AH-64']],
        ['KC-130J', ['KC-130J']],
        ['E-2D Advanced Hawkeye', ['E-2D']],
        ['P-8A Poseidon (MYP)', ['P-8A']],
        // multiple distinct designators in one title, de-duped + order-stable
        ['F-15EX and F-16 Modifications', ['F-15EX', 'F-16']],
        ['F-16 Block Upgrade / F-16 Radar', ['F-16']],
        // hard negatives — no admissible designator
        ['Base Support', []],
        ['Spares and Repair Parts', []],
        ['M10 BOOKER', []], // no hyphen
        ['M777 Howitzer Modifications', []], // no hyphen
        ['C-2 Greyhound', []], // < 3 alphanumerics
        ['Common Ground Equipment', []],
        ['Aircraft Modifications', []],
        // appropriation/budget-activity tags are designator-SHAPED but not platforms
        ['Modification Of In-Svc Equipment (OPA-3)', []],
        ['Physical Security Systems (OPA-3)', []],
        ['Other Support Equipment (OPN-1)', []],
      ] as Array<[string, string[]]>)('"%s" -> %j', (title, expected) => {
        expect(extractDesignatorTerms(title)).toEqual(expected);
      });
    });

    describe('isDesignatorToken', () => {
      it.each([
        ['F-35', true],
        ['B-21', true],
        ['CH-53K', true],
        ['KC-130J', true],
        ['AH-64E', true],
        ['E-2D', true],
        ['C-2', false], // 2 alphanumerics
        ['E-2', false], // 2 alphanumerics
        ['M10', false], // no hyphen
        ['M1A2', false], // no hyphen
        ['Sentinel', false], // no digit
        ['y-12', false], // stoplist
        ['OPA-3', false], // appropriation tag (Other Procurement, Army, BA-3)
        ['OPN-1', false], // appropriation tag (Other Procurement, Navy, BA-1)
        ['APN-5', false], // appropriation tag (Aircraft Procurement, Navy)
      ] as Array<[string, boolean]>)('"%s" -> %s', (token, ok) => {
        expect(isDesignatorToken(token)).toBe(ok);
      });

      it('isTermAcceptable admits designators only under the platform_designator tier', () => {
        // "F-35" is rejected as a program_name (< 5 chars) but valid as a designator.
        expect(isTermAcceptable('F-35', 'program_name')).toBe(false);
        expect(isTermAcceptable('F-35', 'platform_designator')).toBe(true);
        expect(isTermAcceptable('C-2', 'platform_designator')).toBe(false);
        expect(isTermAcceptable('M10', 'platform_designator')).toBe(false);
      });
    });

    describe('matching over a designator bank', () => {
      // F-35 fans to three funding PEs (Navy proc + AF proc + RDT&E); the rest
      // are 1:1. C-2 / M10 / y-12 must be rejected at build.
      const designatorBank = buildNameBank([
        { peCode: '3010FB02100', term: 'B-21', tier: 'platform_designator' },
        { peCode: '1506N0158', term: 'CH-53K', tier: 'platform_designator' },
        { peCode: '0207142F', term: 'F-35', tier: 'platform_designator' },
        { peCode: '0204136N', term: 'F-35', tier: 'platform_designator' },
        { peCode: '0604800F', term: 'F-35', tier: 'platform_designator' },
        { peCode: '9999999X', term: 'C-2', tier: 'platform_designator' }, // <3 alnum
        { peCode: '8888888X', term: 'M10', tier: 'platform_designator' }, // no hyphen
        { peCode: '7777777X', term: 'y-12', tier: 'platform_designator' }, // stoplist
      ]);

      it('rejects the three ineligible designators at build time', () => {
        expect(designatorBank.rejectedCount).toBe(3);
        expect(designatorBank.entries).toHaveLength(5);
      });

      it('matches bare designators in transcript prose with 0.75 confidence', () => {
        const mentions = findMentions(
          'The B-21 Raider entered flight test as the CH-53K achieved full-rate production.',
          designatorBank,
        );
        expect(
          mentions
            .map((m) => ({ peCode: m.peCode, term: m.term, tier: m.tier }))
            .sort((a, b) => a.peCode.localeCompare(b.peCode)),
        ).toEqual([
          { peCode: '1506N0158', term: 'CH-53K', tier: 'platform_designator' },
          { peCode: '3010FB02100', term: 'B-21', tier: 'platform_designator' },
        ]);
        expect(mentions.every((m) => m.confidence === TIER_CONFIDENCE.platform_designator)).toBe(
          true,
        );
      });

      it('fans a shared designator to every funding PE (one mention row each)', () => {
        const mentions = findMentions(
          'Members pressed the witness on F-35 readiness.',
          designatorBank,
        );
        expect(mentions.map((m) => m.peCode).sort()).toEqual(['0204136N', '0207142F', '0604800F']);
        expect(new Set(mentions.map((m) => m.term))).toEqual(new Set(['F-35']));
      });

      it('NEGATIVE: whole-word rule blocks a designator matching inside a variant', () => {
        // bank has "F-35" (not "F-35A"); "F-35A" text must NOT match.
        expect(
          findMentions('The F-35A sustainment tail cost was debated.', designatorBank),
        ).toEqual([]);
      });

      it('NEGATIVE: rejected designators never match even when present in text', () => {
        expect(
          findMentions('The C-2 Greyhound and M10 Booker were mentioned.', designatorBank),
        ).toEqual([]);
      });

      it('links a designator in a bill title (tier participates in bill matching)', () => {
        const candidates = matchBillTitles(
          [{ billId: '119-hr-9100', title: 'F-35 Readiness and Sustainment Improvement Act' }],
          designatorBank,
        );
        expect(candidates.map((c) => c.peCode).sort()).toEqual([
          '0204136N',
          '0207142F',
          '0604800F',
        ]);
        for (const c of candidates) {
          expect(c.tier).toBe('platform_designator');
          expect(c.evidence).toContain('platform designator');
          expect(c.evidence).toContain('"F-35"');
        }
      });
    });
  });
});
