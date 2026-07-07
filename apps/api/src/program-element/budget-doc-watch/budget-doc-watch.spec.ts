import {
  budgetCyclePlan,
  classifyComptrollerLink,
  classifyServiceLink,
  dedupeKeyForReport,
  dedupeKeyForUrl,
  diffNew,
  extractLinks,
  isDefenseRelevantReportTitle,
  loaderHintFor,
  renderDetectionEmail,
  type DetectedDoc,
} from './budget-doc-watch.js';

// Trimmed replica of the live comptroller Budget-Materials page shape
// (verified 2026-07-06): server-rendered anchors, absolute+relative hrefs.
const COMPTROLLER_INDEX_HTML = `
<html><body>
<a href="/budgetmaterials/budget2027.aspx">FY 2027 Budget</a>
<a href="https://comptroller.war.gov/Portals/45/Documents/defbudget/FY2027/FY2027_r1.pdf">R-1</a>
<a href="/Portals/45/Documents/defbudget/FY2027/r1_display.xlsx">R-1 (xlsx)</a>
<a href="/Portals/45/Documents/defbudget/FY2027/FY2027_p1.pdf">P-1 <b>Procurement</b></a>
<a href="/Portals/45/Documents/defbudget/FY2027/FY2027_o1.pdf">O-1</a>
<a href="/Portals/45/Documents/defbudget/FY2027/FY2027_m1.pdf">M-1</a>
<a href="/Portals/45/Documents/defbudget/FY2027/FY2027_Budget_Request.pdf">Budget Request Overview</a>
<a href="mailto:webmaster@war.gov">contact</a>
<a href="javascript:void(0)">menu</a>
</body></html>`;

describe('budget-doc-watch pure logic', () => {
  describe('extractLinks', () => {
    it('extracts and resolves anchors, skipping mailto/javascript', () => {
      const links = extractLinks(COMPTROLLER_INDEX_HTML, 'https://comptroller.war.gov/Budget-Materials/');
      const hrefs = links.map((l) => l.href);
      expect(hrefs).toContain('https://comptroller.war.gov/budgetmaterials/budget2027.aspx');
      expect(hrefs).toContain(
        'https://comptroller.war.gov/Portals/45/Documents/defbudget/FY2027/FY2027_r1.pdf',
      );
      expect(hrefs.some((h) => h.startsWith('mailto:'))).toBe(false);
      expect(hrefs.some((h) => h.startsWith('javascript:'))).toBe(false);
    });

    it('flattens nested tags in link text', () => {
      const links = extractLinks(COMPTROLLER_INDEX_HTML, 'https://comptroller.war.gov/');
      const p1 = links.find((l) => l.href.endsWith('FY2027_p1.pdf'));
      expect(p1?.text).toBe('P-1 Procurement');
    });
  });

  describe('classifyComptrollerLink', () => {
    it.each([
      ['https://comptroller.war.gov/Portals/45/Documents/defbudget/FY2027/FY2027_r1.pdf', 'r1', 2027],
      ['https://comptroller.war.gov/Portals/45/Documents/defbudget/FY2027/r1_display.xlsx', 'r1', 2027],
      ['https://comptroller.war.gov/Portals/45/Documents/defbudget/FY2027/FY2027_p1.pdf', 'p1', 2027],
      ['https://comptroller.war.gov/Portals/45/Documents/defbudget/FY2027/FY2027_p1r.pdf', 'p1r', 2027],
      ['https://comptroller.war.gov/Portals/45/Documents/defbudget/FY2027/FY2027_o1.pdf', 'o1', 2027],
      ['https://comptroller.war.gov/Portals/45/Documents/defbudget/FY2027/FY2027_m1.pdf', 'm1', 2027],
      ['https://comptroller.war.gov/Portals/45/Documents/defbudget/FY2028/FY2028_c1.pdf', 'c1', 2028],
      ['https://comptroller.war.gov/budgetmaterials/budget2028.aspx', 'fy_index', 2028],
    ])('%s -> %s FY%i', (url, docType, fy) => {
      const c = classifyComptrollerLink(url, '');
      expect(c).toEqual({ docType, fiscalYear: fy });
    });

    it('classifies unknown defbudget PDFs as jbook_detail', () => {
      const c = classifyComptrollerLink(
        'https://comptroller.war.gov/Portals/45/Documents/defbudget/FY2027/FY2027_Budget_Request.pdf',
        'Budget Request',
      );
      expect(c).toEqual({ docType: 'jbook_detail', fiscalYear: 2027 });
    });

    it('ignores non-budget links', () => {
      expect(classifyComptrollerLink('https://comptroller.war.gov/About/', 'About')).toBeNull();
      expect(
        classifyComptrollerLink('https://comptroller.war.gov/Portals/45/style.css', ''),
      ).toBeNull();
    });
  });

  describe('classifyServiceLink', () => {
    it('maps the NNpres convention to a fiscal year', () => {
      const c = classifyServiceLink(
        'https://www.secnav.navy.mil/fmc/fmb/Documents/27pres/RDTEN_BA4_Book.pdf',
      );
      expect(c).toEqual({ docType: 'jbook_detail', fiscalYear: 2027 });
    });
    it('falls back to a 4-digit year path segment', () => {
      const c = classifyServiceLink(
        'https://www.saffm.hq.af.mil/Portals/84/documents/FM-Resources/2027/AF_RDTE_Vol1.pdf',
      );
      expect(c).toEqual({ docType: 'jbook_detail', fiscalYear: 2027 });
    });
    it('ignores non-PDF links', () => {
      expect(classifyServiceLink('https://www.secnav.navy.mil/fmc/fmb/Pages/Fiscal-Year-Budget.aspx')).toBeNull();
    });
  });

  describe('dedupe keys', () => {
    it('normalizes host case and strips query/hash', () => {
      expect(dedupeKeyForUrl('https://Comptroller.WAR.gov/Portals/45/x.pdf?v=2#page=3')).toBe(
        'comptroller.war.gov/portals/45/x.pdf',
      );
    });
    it('derives stable report keys from citations', () => {
      expect(dedupeKeyForReport('H. Rept. 119-123')).toBe('crpt:h-rept-119-123');
      expect(dedupeKeyForReport('S. Rept. 119-45, Part 2')).toBe('crpt:s-rept-119-45-part-2');
    });
  });

  describe('diffNew — the baseline / synthetic-new-document contract', () => {
    const doc = (key: string): DetectedDoc => ({
      dedupeKey: key,
      url: `https://comptroller.war.gov/${key}`,
      title: key,
      publisher: 'comptroller',
      docType: 'r1',
      fiscalYear: 2027,
      fetchable: true,
      loaderHint: 'x',
    });

    it('returns nothing when every current doc is already known (baseline run)', () => {
      const current = [doc('a'), doc('b')];
      expect(diffNew(current, new Set(['a', 'b']))).toEqual([]);
    });

    it('detects exactly one synthetic new document against a known baseline', () => {
      const current = [doc('a'), doc('b'), doc('fy2028-r1')];
      const out = diffNew(current, new Set(['a', 'b']));
      expect(out).toHaveLength(1);
      expect(out[0]?.dedupeKey).toBe('fy2028-r1');
    });

    it('never emits the same key twice in one run (index pages repeat links)', () => {
      const current = [doc('a'), doc('a')];
      expect(diffNew(current, new Set())).toHaveLength(1);
    });
  });

  describe('budgetCyclePlan — bound to current + prior cycle, not 20 years of archives', () => {
    it('picks max FY as the detect floor and max-1 as the crawl floor', () => {
      // The comptroller index links budget2027 down to budget2006.
      const years = Array.from({ length: 22 }, (_, i) => 2027 - i);
      const plan = budgetCyclePlan(years);
      expect(plan.maxFy).toBe(2027);
      expect(plan.detectFloor).toBe(2027); // only budget2027 (or newer) is a detection
      expect(plan.crawlFloor).toBe(2026); // crawl current + immediately prior
    });

    it('a future PB page becomes the new detect floor', () => {
      const plan = budgetCyclePlan([2028, 2027, 2026, 2025]);
      expect(plan.detectFloor).toBe(2028);
      expect(plan.crawlFloor).toBe(2027);
    });

    it('handles an empty link set', () => {
      expect(budgetCyclePlan([])).toEqual({ maxFy: null, crawlFloor: 0, detectFloor: 0 });
    });

    it('the archive years fall below both floors (no detection, no crawl)', () => {
      const plan = budgetCyclePlan([2027, 2026, 2010, 2006]);
      expect(2010 < plan.crawlFloor).toBe(true);
      expect(2006 < plan.detectFloor).toBe(true);
      expect(2026 >= plan.crawlFloor).toBe(true); // prior cycle still crawled
      expect(2027 >= plan.detectFloor).toBe(true); // current cycle still detected
    });
  });

  describe('isDefenseRelevantReportTitle', () => {
    it('keeps defense approps + NDAA reports and drops the rest', () => {
      expect(isDefenseRelevantReportTitle('DEPARTMENT OF DEFENSE APPROPRIATIONS BILL, 2027')).toBe(true);
      expect(isDefenseRelevantReportTitle('Military Construction, Veterans Affairs, and Related Agencies')).toBe(true);
      expect(isDefenseRelevantReportTitle('AGRICULTURE, RURAL DEVELOPMENT APPROPRIATIONS BILL')).toBe(false);
    });
  });

  describe('renderDetectionEmail', () => {
    it('flags non-fetchable publishers for manual download and carries loader hints', () => {
      const blocked: DetectedDoc = {
        dedupeKey: 'k',
        url: 'https://www.saffm.hq.af.mil/x.pdf',
        title: 'AF RDT&E Vol 1',
        publisher: 'saffm',
        docType: 'jbook_detail',
        fiscalYear: 2027,
        fetchable: false,
        loaderHint: loaderHintFor('jbook_detail', 'saffm'),
      };
      const { subject, text, html } = renderDetectionEmail([blocked], []);
      expect(subject).toContain('1 new/changed document');
      expect(text).toContain('MANUAL BROWSER DOWNLOAD REQUIRED');
      expect(text).toContain('sync-jbook-r2');
      expect(html).toContain('Manual browser download required');
    });

    it('renders sha revisions with re-run guidance', () => {
      const { text } = renderDetectionEmail(
        [],
        [
          {
            dedupeKey: 'rev:x',
            sourceKey: 'jbook_r1_fy2027',
            url: 'https://comptroller.war.gov/Portals/45/Documents/defbudget/FY2027/FY2027_r1.pdf',
            priorSha256: 'a'.repeat(64),
            newSha256: 'b'.repeat(64),
            loaderHint: loaderHintFor('r1', 'comptroller'),
          },
        ],
      );
      expect(text).toContain('REVISED jbook_r1_fy2027');
      expect(text).toContain('version-chain');
    });
  });
});
