import {
  parseFlFarListingPage,
  parseFlFarNoticeDetail,
  parseMdyDate,
  toStateRuleInput,
} from './fl-far.client.js';

// Fixtures below are TRIMMED EXCERPTS of REAL HTML fetched live from
// flrules.org (verified 2026-07-10) — including its real quoting
// inconsistencies (`class=notice_text` vs `class="notice_text"`,
// `id=textarea2` unquoted) — so these tests prove the parser survives the
// actual markup, not an idealized version of it.

const LISTING_HTML = `
<html><body>
<tr><td nowrap><b>Total number found: 398</b></td></tr>
<table width="100%"><tr><td align=right class=field_text>Page: <font color =Navy size=3> <b>1</b></font>&nbsp;<a href="QuickResult.asp?P0=Stat_Prop_All&P1=0&P2=169&page=2">2</a>&nbsp;<a href="QuickResult.asp?P0=Stat_Prop_All&P1=0&P2=169&page=2">NEXT ></a>&nbsp;</td></tr></table>
<table class="tabDisplay"  style="table-latyout:fixed;" >
  <tr class="" >
    <td nowrap class="patency" align="center">
      <a href = "/gateway/notice_Files.asp?ID=31100933">
      <img src="../images/view_word.png" title="View Text" alt="View Text" /></a>
    </td>
    <td Align="Center" style="width:100px;overflow:hidden;word-wrap:break-word;">Proposed<br>
      <a title="go to Rule Page" class=RuleNumber href=/gateway/ruleNo.asp?id=65G-11.004>65G-11.004</a>
    </td>
    <td  >To conform the rule to the changes made by Chapter 2026-129, L.O.F.</td>
    <td  nowrap align ="center" ><a class="id"  title="go to Notice Page" href="/Gateway/View_notice.asp?id=31100933">
    31100933</a>
    </td>
    <td  nowrap align =center>
      <a class="PublishDate"  title="go to FAR Issue Page" href="/BigDoc/View_Faw.asp?IID=4684"> 7/10/2026<br>Vol. 52/133 </a>
    </td>
  </tr>
  <tr class="tdBg1" >
    <td nowrap class="patency" align="center"></td>
    <td Align="Center" style="width:100px;overflow:hidden;word-wrap:break-word;">Proposed<br>
      <a title="go to Rule Page" class=RuleNumber href=/gateway/ruleNo.asp?id=65C-1.001>65C-1.001</a>
    </td>
    <td>Another rule change.</td>
    <td  nowrap align ="center" ><a class="id"  title="go to Notice Page" href="/Gateway/View_notice.asp?id=31100836">
    31100836</a>
    </td>
    <td nowrap align=center>
      <a class="PublishDate" title="go to FAR Issue Page" href="/BigDoc/View_Faw.asp?IID=4684"> 7/9/2026<br>Vol. 52/132 </a>
    </td>
  </tr>
</table>
</body></html>
`;

const NOTICE_DETAIL_HTML = `
<html><body>
<table>
<tr><td class="HeaderGrayBar" background="/images/bar_bg.gif" colspan=2 height="23">
    Notice: 31100933
</td></tr>
<tr><td class=notice_text colspan=2 height="23" >
    Notice of Proposed Rule
</td></tr>

<tr><td class="field_header notice_tl" align=right> Department:  </td><td class="notice_text">
        <a class="FX_Link_header"
            href="/gateway/department.asp?deptid=65" target="department">DEPARTMENT OF CHILDREN AND FAMILIES</a>
</td></tr>

<tr><td class="field_header notice_tl" align=right> Division:  </td><td class="notice_text">
    <a class="FX_Link_header"
        href="/gateway/organization.asp?divid=560" target="organization">Agency for Persons with Disabilities</a>
</td></tr>

<tr>
<td align="right" nowrap valign="top" class="field_header notice_tl">RULE:
</td>
<td class="notice_text" valign="top">

<table border = 0 cellspacing =0 cellpadding=0 >
<TR><TD align = left nowrap valign= top><a class = FX_Link_ID href=/gateway/RuleNo.asp?id=65G-11.004 target=RuleNo>65G-11.004</a> &nbsp; </td><td align=left class=results valign=middle>Crisis Determination Procedure</td> </tr>
</table>

</td>
</tr>

<tr>
<td align="right" nowrap valign="top" class="field_header notice_tl"><label for="textarea2">PURPOSE: </label>
</td>
<td valign="top"> <textarea readonly rows="4" cols="75" class="text_field" id=textarea2 name=textarea2>To conform the rule to the changes made by Chapter 2026-129, L.O.F., to Section 393.063, F.S., regarding &#8220;Tatton-Brown-Rahman syndrome.&#8221;</textarea>
</td>
</tr>

<tr>
<td align="right" nowrap valign="top" class="field_header notice_tl"><label for="textarea1">SUMMARY:</label>
</td>
<td valign="top"> <textarea readonly rows="4" cols="75" class="text_field" id=textarea1 name=textarea1>The proposed changes amend the rule to add Tatton-Brown-Rahman syndrome to the list of conditions.</textarea>
</td>
</tr>

<tr>
<td align="right" nowrap valign="top" class="field_header notice_tl">PRINT PUBLISH DATE: </td>
<td class="notice_text" valign="top">7/10/2026&nbsp;&nbsp;&nbsp;<a href=/BigDoc/View_FAW.asp?iid=4684>Vol. 52/133</a></td>
</tr>

<tr>
<td align="right" nowrap valign="top" class="field_header notice_tl">COMMENTS:
</td>
<td class="notice_text" > From <b> 7/10/2026 </b> To <b> 7/31/2026</b> (21 Days)<BR>
<form method="post" action="/subscriber/comment.asp"></form>
</td>
</tr>
</table>
</body></html>
`;

describe('parseMdyDate', () => {
  it('converts M/D/YYYY to YYYY-MM-DD, zero-padded', () => {
    expect(parseMdyDate('7/10/2026')).toBe('2026-07-10');
    expect(parseMdyDate('12/1/2025')).toBe('2025-12-01');
  });
  it('returns null for malformed or missing input, never guessing', () => {
    expect(parseMdyDate(null)).toBeNull();
    expect(parseMdyDate('')).toBeNull();
    expect(parseMdyDate('not a date')).toBeNull();
  });
});

describe('parseFlFarListingPage (real FAR listing markup)', () => {
  it('extracts notice id, rule number, and publish date per row despite unquoted attributes', () => {
    const page = parseFlFarListingPage(LISTING_HTML);
    expect(page.rows).toHaveLength(2);
    expect(page.rows[0]).toEqual({
      noticeId: '31100933',
      ruleNumber: '65G-11.004',
      publishDate: '2026-07-10',
    });
    expect(page.rows[1]).toEqual({
      noticeId: '31100836',
      ruleNumber: '65C-1.001',
      publishDate: '2026-07-09',
    });
  });
  it('extracts the total-found count and next-page flag', () => {
    const page = parseFlFarListingPage(LISTING_HTML);
    expect(page.totalFound).toBe(398);
    expect(page.hasNextPage).toBe(true);
  });
  it('returns an empty page (never throws) on unrecognized markup', () => {
    const page = parseFlFarListingPage('<html><body>nothing here</body></html>');
    expect(page.rows).toEqual([]);
    expect(page.hasNextPage).toBe(false);
  });
});

describe('parseFlFarNoticeDetail (real FAR notice-detail markup)', () => {
  it('extracts every field from the real page structure', () => {
    const detail = parseFlFarNoticeDetail(NOTICE_DETAIL_HTML, '31100933');
    expect(detail.noticeType).toBe('Notice of Proposed Rule');
    expect(detail.department).toBe('DEPARTMENT OF CHILDREN AND FAMILIES');
    expect(detail.division).toBe('Agency for Persons with Disabilities');
    expect(detail.ruleNumber).toBe('65G-11.004');
    expect(detail.ruleTitle).toBe('Crisis Determination Procedure');
    expect(detail.purpose).toContain('Tatton-Brown-Rahman syndrome');
    // cheerio decodes the &#8220;/&#8221; HTML entities to real curly quotes.
    expect(detail.purpose).toContain('“Tatton-Brown-Rahman syndrome.”');
    expect(detail.summary).toContain('add Tatton-Brown-Rahman syndrome');
    expect(detail.publishDate).toBe('2026-07-10');
    expect(detail.registerCitation).toBe('Vol. 52/133');
    expect(detail.commentStartDate).toBe('2026-07-10');
    expect(detail.commentEndDate).toBe('2026-07-31');
  });
});

describe('toStateRuleInput', () => {
  it('maps a parsed proposed-rule notice to the StateRule upsert shape', () => {
    const detail = parseFlFarNoticeDetail(NOTICE_DETAIL_HTML, '31100933');
    const input = toStateRuleInput(detail);
    expect(input).toMatchObject({
      id: 'FL-31100933',
      state: 'FL',
      agency: 'DEPARTMENT OF CHILDREN AND FAMILIES — Agency for Persons with Disabilities',
      title: 'Crisis Determination Procedure',
      ruleType: 'proposed',
      docketId: '31100933',
      registerCitation: 'Vol. 52/133',
      publicationDate: '2026-07-10',
      commentStartDate: '2026-07-10',
      commentEndDate: '2026-07-31',
      effectiveDate: null,
      sourceUrl: 'https://flrules.org/Gateway/View_notice.asp?id=31100933',
    });
  });

  it('classifies an emergency-rule notice type into ruleType=emergency', () => {
    const detail = parseFlFarNoticeDetail(
      NOTICE_DETAIL_HTML.replace('Notice of Proposed Rule', 'Emergency Rule'),
      '31100933',
    );
    expect(toStateRuleInput(detail)?.ruleType).toBe('emergency');
  });

  it('returns null (never fabricates a row) when the rule title or publish date is missing', () => {
    const detail = parseFlFarNoticeDetail('<html><body>empty</body></html>', '99999999');
    expect(toStateRuleInput(detail)).toBeNull();
  });
});
