/* District Nexus — prototype application.
   Styling vocabulary and tokens mirror apps/web/src/theme.css + legiwatch.css. */
'use strict';

/* ── icons ─────────────────────────────────────────── */
const I = {
  cv:'<svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6l4 4 4-4"/></svg>',
  ck:'<svg width="9" height="9" viewBox="0 0 16 16" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.5l3.5 3.5L13 4.5"/></svg>',
  x:'<svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>',
  ar:'<svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3l5 5-5 5"/></svg>',
  ext:'<svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3h4v4M13 3L7.5 8.5M11 9.5V13H3V5h3.5"/></svg>',
  warn:'<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2.6L14.5 13.4H1.5z"/><path d="M8 6.4v3.1M8 11.6h.01"/></svg>',
  info:'<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="8" cy="8" r="6.2"/><path d="M8 7.4v3.6M8 5.1h.01"/></svg>',
  clock:'<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="8" cy="8" r="6.2"/><path d="M8 4.6V8l2.4 1.6"/></svg>',
  plus:'<svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M8 3.5v9M3.5 8h9"/></svg>',
  minus:'<svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M3.5 8h9"/></svg>',
  layers:'<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="M8 1.8L14.6 5.4 8 9 1.4 5.4z"/><path d="M2.4 8.4L8 11.4l5.6-3M2.4 11.2L8 14.2l5.6-3"/></svg>',
  search:'<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="7" cy="7" r="4.6"/><path d="M10.4 10.4L14 14"/></svg>',
  home:'<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="M2.4 7L8 2.4 13.6 7v6.4H2.4z"/></svg>',
  users:'<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="6" cy="5.6" r="2.4"/><path d="M1.8 13.4c0-2.4 1.9-3.9 4.2-3.9s4.2 1.5 4.2 3.9"/><path d="M11 4c1.3 0 2.2 1 2.2 2.2S12.3 8.4 11 8.4M12.2 9.9c1.3.4 2 1.6 2 3.5"/></svg>',
  book:'<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="M2.4 3.2h4.2c.8 0 1.4.6 1.4 1.4v8.2c0-.8-.6-1.4-1.4-1.4H2.4z"/><path d="M13.6 3.2H9.4c-.8 0-1.4.6-1.4 1.4v8.2c0-.8.6-1.4 1.4-1.4h4.2z"/></svg>',
  radar:'<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="8" cy="8" r="6.2"/><circle cx="8" cy="8" r="3"/><path d="M8 8l4.4-4.4"/></svg>',
  grid:'<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="2.2" y="2.2" width="4.6" height="4.6" rx="1"/><rect x="9.2" y="2.2" width="4.6" height="4.6" rx="1"/><rect x="2.2" y="9.2" width="4.6" height="4.6" rx="1"/><rect x="9.2" y="9.2" width="4.6" height="4.6" rx="1"/></svg>',
  pin:'<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M8 14.4s4.6-4.3 4.6-7.6A4.6 4.6 0 003.4 6.8c0 3.3 4.6 7.6 4.6 7.6z"/><circle cx="8" cy="6.7" r="1.7"/></svg>',
  graph:'<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="4" cy="4" r="1.9"/><circle cx="12.2" cy="5.4" r="1.9"/><circle cx="7" cy="12.2" r="1.9"/><path d="M5.6 5.2l5 .9M5 5.9l1.4 4.5M10.9 7l-2.7 3.7"/></svg>',
  chart:'<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M2.4 13.4h11.2"/><path d="M4.6 13.4V8M8 13.4V3.6M11.4 13.4V6.4"/></svg>',
  gear:'<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="8" cy="8" r="2.3"/><path d="M8 1.6l.9 1.7 1.9-.4.5 1.9 1.8.7-.8 1.8.8 1.8-1.8.7-.5 1.9-1.9-.4L8 14.4l-.9-1.7-1.9.4-.5-1.9-1.8-.7.8-1.8-.8-1.8 1.8-.7.5-1.9 1.9.4z"/></svg>',
  bolt:'<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="M9 1.6L3.4 9.2h3.8l-.6 5.2L12.6 6.8H8.8z"/></svg>',
  cal:'<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="2.2" y="3.4" width="11.6" height="10.4" rx="1.6"/><path d="M2.2 6.6h11.6M5.4 1.8v2.6M10.6 1.8v2.6"/></svg>'
};

/* ── helpers ───────────────────────────────────────── */
const $ = (s, r) => (r || document).querySelector(s);
const el = (h) => { const t = document.createElement('template'); t.innerHTML = h.trim(); return t.content.firstElementChild; };
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
function money(n, dec) {
  if (n == null) return '—';
  const a = Math.abs(n);
  if (a >= 1e9) return '$' + (n/1e9).toFixed(dec == null ? 2 : dec) + 'B';
  if (a >= 1e6) return '$' + (n/1e6).toFixed(dec == null ? 1 : dec) + 'M';
  if (a >= 1e3) return '$' + Math.round(n/1e3) + 'K';
  return '$' + n;
}
const num = (n) => n == null ? '—' : n.toLocaleString('en-US');
function ago(iso) {
  const h = Math.round((Date.now() - new Date(iso.replace(' ', 'T')).getTime()) / 36e5);
  if (h < 1) return 'just now';
  if (h < 24) return h + 'h ago';
  const d = Math.round(h / 24);
  return d === 1 ? 'yesterday' : d + 'd ago';
}
const fdate = (s) => s ? new Date(s + 'T12:00:00').toLocaleDateString('en-US', {month:'short', day:'numeric', year:'numeric'}) : '—';

function toast(msg, sub) {
  let w = $('#toastw');
  if (!w) { w = el('<div id="toastw"></div>'); document.body.appendChild(w); }
  const t = el(`<div class="toast"><span style="color:#8fb0ff;display:grid;place-items:center">${I.info}</span>
    <div><div>${esc(msg)}</div>${sub ? `<div class="tsub">${esc(sub)}</div>` : ''}</div></div>`);
  w.appendChild(t);
  setTimeout(() => t.remove(), 2800);
}
const link = (dest) => toast('This route exists in Capiro but is outside this prototype.', dest);

let openPop = null;
document.addEventListener('click', (e) => { if (openPop && !openPop.contains(e.target)) closePop(); });
function closePop() { if (openPop) { const m = $('.dn-menu', openPop); if (m) m.remove(); const s = $('.dn-select', openPop); if (s) s.classList.remove('on'); openPop = null; } }
function popover(host, html, right) {
  if (openPop === host) { closePop(); return null; }
  closePop();
  const m = el(`<div class="dn-menu${right ? ' r' : ''}">${html}</div>`);
  host.appendChild(m);
  const s = $('.dn-select', host); if (s) s.classList.add('on');
  openPop = host;
  return m;
}

/* ── scoring (mirrors §7-F weights) ────────────────── */
const WEIGHTS = [
  {id:'facility',     label:'Verified physical facility',      w:25, color:'#1a3f9f'},
  {id:'employee',     label:'Verified employee aggregate',     w:20, color:'#2a57ce'},
  {id:'contract',     label:'Contract place of performance',   w:10, color:'#5b7ed6'},
  {id:'grant',        label:'Grant place of performance',      w:10, color:'#8ea9e4'},
  {id:'supplier',     label:'Supplier or local spend',         w:10, color:'#b9caee'},
  {id:'partner',      label:'Partner / beneficiary evidence',  w:10, color:'#2e6b43'},
  {id:'policy',       label:'Policy and committee relevance',  w:10, color:'#6a2eb5'},
  {id:'relationship', label:'Relationship and target context', w:5,  color:'#a26913'}
];
const BANDS = [[60,'Strong','#1a3f9f'],[35,'Moderate','#2a57ce'],[15,'Limited','#8a8780'],[0,'Minimal','#b5b0a4']];
const bandOf = (s) => BANDS.find(b => s >= b[0]);

function scoreDistrict(d, clientIds) {
  const rows = d.rows.filter(r => !clientIds || clientIds.includes(r.c));
  const attr = d.cAttr || d.rows.map(r => r.c);
  const hits = !clientIds || attr.some(c => clientIds.includes(c));
  const contracts = hits ? d.contracts : {obl:0, n:0, basis:null};
  const grants = hits ? d.grants : {obl:0, outl:0, n:0, basis:null};
  const targets = d.targets.filter(t => !clientIds || clientIds.includes(t.c));
  const emps = rows.filter(r => r.emp != null);
  const ambiguous = rows.some(r => r.geocode !== 'matched');
  const b = [];
  const add = (id, credited, has, basis, note) => {
    const W = WEIGHTS.find(x => x.id === id);
    b.push({id, label:W.label, weight:W.w, color:W.color, credited, has, basis, note});
  };
  add('facility', rows.length ? (ambiguous ? 12 : 25) : 0, rows.length > 0, 'facility',
      rows.length ? (ambiguous ? 'One facility geocode is ambiguous — half weight' : rows.length + ' verified facility site' + (rows.length > 1 ? 's' : '')) : 'No client facility recorded');
  add('employee', emps.length ? 20 : 0, rows.length > 0, 'employee_aggregate',
      rows.length ? (emps.length ? num(emps.reduce((a, r) => a + r.emp, 0)) + ' employees reported' : 'Employee count not reported (null ≠ 0)') : 'No client facility recorded');
  add('contract', contracts.n ? (contracts.basis === 'place_of_performance' ? 10 : 4) : 0, contracts.n > 0, contracts.basis,
      contracts.n ? (contracts.basis === 'place_of_performance' ? money(contracts.obl) + ' obligated, place of performance' : money(contracts.obl) + ' — recipient location only, reduced weight') : 'No contract activity in district');
  add('grant', grants.n ? (grants.basis === 'place_of_performance' ? 10 : 4) : 0, grants.n > 0, grants.basis,
      grants.n ? (grants.basis === 'place_of_performance' ? money(grants.obl) + ' obligated, place of performance' : money(grants.obl) + ' — recipient location only, reduced weight') : 'No awarded assistance in district');
  add('supplier', 0, false, null, 'No supplier or local-spend evidence submitted');
  add('partner', 0, false, null, 'No partner or beneficiary evidence submitted');
  add('policy', d.policy.jurisdiction ? 10 : 0, true, null, d.policy.jurisdiction ? d.policy.note : 'Member holds no assignment of jurisdiction for this client');
  add('relationship', targets.length ? 5 : 0, true, null, targets.length ? targets.length + ' active target, last contact ' + fdate(targets[0].last) : 'No target or logged outreach');

  return {
    score: Math.round(b.reduce((a, x) => a + x.credited, 0)),
    coverage: b.filter(x => x.has).reduce((a, x) => a + x.weight, 0),
    breakdown:b, rows, contracts, grants, targets,
    employees: emps.length ? emps.reduce((a, r) => a + r.emp, 0) : null,
    empUnknown: rows.length > 0 && emps.length < rows.length,
    facilities: rows.reduce((a, r) => a + r.fac, 0),
    clients: Array.from(new Set(rows.map(r => r.c).concat(hits ? attr : [])))
  };
}

/* ── state ─────────────────────────────────────────── */
const S = {
  route:'nexus', client:null, metric:'nexus', view:'current',
  nexusTypes:['facility','employee','contract','grant','target'],
  agencies:[], minAmount:0, includeInferred:true, sort:'nexus',
  selected:null, filterKeys:null, findingsClosed:false,
  showFacilities:true, basemap:false, futureAvailable:false,
  pageState:'normal', profileClient:'mer', mapSource:'assistance_recipient'
};
let GEO = null, mapObj = null, geoLayer = null, facLayer = null;
const byKey = Object.fromEntries(DISTRICTS.map(d => [d.k, d]));

function activeDistricts() {
  const ids = S.client ? [S.client] : null;
  let list = DISTRICTS.map(d => Object.assign({}, d, scoreDistrict(d, ids)));
  if (S.client) list = list.filter(d => d.rows.length || d.contracts.n || d.grants.n || d.targets.length);
  list = list.filter(d => {
    const t = S.nexusTypes;
    const has = (d.rows.length && (t.includes('facility') || t.includes('employee'))) ||
                (d.contracts.n && t.includes('contract')) ||
                (d.grants.n && t.includes('grant')) ||
                (d.targets.length && t.includes('target'));
    if (!has) return false;
    if (!S.includeInferred && !d.rows.length &&
        d.breakdown.some(x => x.basis === 'recipient_location' && x.credited) &&
        !d.breakdown.some(x => x.basis === 'place_of_performance' && x.credited)) return false;
    if (S.minAmount && (d.contracts.obl + d.grants.obl) < S.minAmount) return false;
    if (S.agencies.length) {
      const ag = AWARDS.filter(a => a.d === d.k).map(a => a.agency);
      if (!S.agencies.some(x => ag.includes(x)) && !(S.agencies.includes('Defense') && d.contracts.n > 0)) return false;
    }
    return true;
  });
  if (S.view === 'future') list = list.filter(d => d.futureChange);
  const sorters = {
    nexus:(a, b) => b.score - a.score,
    contracts:(a, b) => b.contracts.obl - a.contracts.obl,
    grants:(a, b) => b.grants.obl - a.grants.obl,
    employees:(a, b) => (b.employees || 0) - (a.employees || 0),
    coverage:(a, b) => b.coverage - a.coverage,
    key:(a, b) => a.k.localeCompare(b.k)
  };
  return list.sort(sorters[S.sort] || sorters.nexus);
}
function totals(list, clientOverride) {
  const cid = clientOverride !== undefined ? clientOverride : S.client;
  const t = {districts:list.length, facilities:0, employees:0, empUnknown:0, contracts:0, grants:0, outlays:0,
             unmappedC:0, unmappedG:0, opps:0, oppEst:0, clients:new Set(), _list:list};
  list.forEach(d => {
    t.facilities += d.facilities; if (d.employees) t.employees += d.employees;
    if (d.empUnknown) t.empUnknown++;
    t.contracts += d.contracts.obl; t.grants += d.grants.obl; t.outlays += d.grants.outl;
    d.clients.forEach(c => t.clients.add(c));
  });
  const cf = (x) => !cid || x.c === cid;
  t.unmappedC = UNPLACED_CONTRACTS.filter(cf).reduce((a, x) => a + x.obl, 0);
  t.unmappedG = UNPLACED.filter(cf).reduce((a, x) => a + x.obl, 0);
  const op = OPPS.filter(o => !cid || o.client === cid);
  t.opps = op.length; t.oppEst = op.reduce((a, o) => a + (o.est || 0), 0);
  return t;
}

/* ── colour scales ─────────────────────────────────── */
const RAMP = ['#edf1fa','#dee6f8','#bccdf0','#8ea9e4','#547ad4','#2a57ce'];
const SCALES = {
  nexus:{breaks:[1,15,35,50,65], label:'Nexus strength', ticks:['0','15','35','50','65','80+']},
  contracts:{breaks:[1,2e6,6e6,12e6,22e6], label:'Contract obligations', ticks:['$0','2M','6M','12M','22M','+']},
  grants:{breaks:[1,2e6,6e6,12e6,20e6], label:'Grant obligations', ticks:['$0','2M','6M','12M','20M','+']},
  employees:{breaks:[1,150,400,800,1500], label:'Employees represented', ticks:['0','150','400','800','1.5K','+']},
  clients:{breaks:[1,2,3,4,5], label:'Clients with nexus', ticks:['0','1','2','3','4','5+']},
  coverage:{breaks:[1,35,50,65,80], label:'Evidence coverage', ticks:['0','35','50','65','80','100']}
};
const metricValue = (d) => ({nexus:d.score, contracts:d.contracts.obl, grants:d.grants.obl,
  employees:d.employees || 0, clients:d.clients.length, coverage:d.coverage})[S.metric];
function rampColor(v) {
  const bk = SCALES[S.metric].breaks;
  let i = 0; while (i < bk.length && v >= bk[i]) i++;
  return RAMP[Math.max(0, i - 1)] || RAMP[0];
}

/* ══ NAV ═══════════════════════════════════════════════ */
const NAV = [
  {t:'item', k:'home', ic:I.home, n:'Dashboard', stub:true},
  {t:'item', k:'clients', ic:I.users, n:'Portfolio'},
  {t:'item', k:'directory', ic:I.book, n:'Directory', stub:true},
  {t:'grp', n:'Intelligence'},
  {t:'sub', k:'legiwatch', n:'LegiWatch', stub:true},
  {t:'sub', k:'explorer', n:'Data Explorer'},
  {t:'sub', k:'nexus', n:'District Nexus', flag:'BETA'},
  {t:'sub', k:'graph', n:'Knowledge Graph', stub:true},
  {t:'sub', k:'pe', n:'Program Elements', stub:true},
  {t:'grp', n:'Workspace'},
  {t:'item', k:'strategy', ic:I.chart, n:'Strategies', stub:true},
  {t:'item', k:'mappings', ic:I.gear, n:'Settings'}
];
function renderNav() {
  const rk = {nexus:'nexus', client:'clients', mappings:'mappings', explorer:'explorer'}[S.route];
  $('#nav').innerHTML = NAV.map(n => n.t === 'grp'
    ? `<div class="nav-group">${n.n}</div>`
    : `<button class="nav-item${n.t === 'sub' ? ' nested' : ''}${n.k === rk ? ' active' : ''}${n.stub ? ' stub' : ''}" data-nav="${n.k}">
         ${n.ic ? `<span class="ico">${n.ic}</span>` : ''}<span>${n.n}</span>${n.flag ? `<span class="nav-flag">${n.flag}</span>` : ''}</button>`).join('');
  $('#nav').querySelectorAll('[data-nav]').forEach(x => x.onclick = () => {
    const k = x.dataset.nav;
    if (['nexus','clients','mappings','explorer'].includes(k)) {
      S.route = {nexus:'nexus', clients:'client', mappings:'mappings', explorer:'explorer'}[k];
      closeDrawer(); render();
    } else toast('Outside this prototype — District Nexus, Data Explorer, the client Intelligence tab and Intelligence Mappings are built out.');
  });
}

/* ══ SHARED ════════════════════════════════════════════ */
function evidenceChips(d, max) {
  const c = [];
  if (d.rows.length) c.push(['v', 'Facility']);
  if (d.employees) c.push(['v', num(d.employees) + ' emp']);
  else if (d.rows.length) c.push(['w', 'Employees n/r']);
  if (d.contracts.n) c.push([d.contracts.basis === 'place_of_performance' ? 'v' : 'w', 'Contracts' + (d.contracts.basis === 'recipient_location' ? ' · recip. loc.' : '')]);
  if (d.grants.n) c.push([d.grants.basis === 'place_of_performance' ? 'v' : 'w', 'Grants' + (d.grants.basis === 'recipient_location' ? ' · recip. loc.' : '')]);
  if (d.policy.jurisdiction) c.push(['v', 'Jurisdiction']);
  if (d.targets.length) c.push(['v', 'Target']);
  const shown = max ? c.slice(0, max) : c;
  return shown.map(x => `<span class="ec${x[0] === 'w' ? ' w' : ''}"><i class="d"></i>${esc(x[1])}</span>`).join('') +
    (c.length > shown.length ? `<span class="ec w">+${c.length - shown.length}</span>` : '');
}
const ebar = (d) => `<div class="ebar" role="img" aria-label="Nexus score ${d.score} of 100">` +
  d.breakdown.filter(b => b.credited > 0).map(b => `<i style="width:${b.credited}%;background:${b.color}"></i>`).join('') + `</div>`;

/* ══ ROUTE: DISTRICT NEXUS ═════════════════════════════ */
function renderNexus() {
  if (S.pageState === 'flagoff') { $('#main').innerHTML = topbarHTML() + flagOffHTML(); wireTopbar(); return; }
  const list = activeDistricts();
  const t = totals(list);
  $('#main').innerHTML = topbarHTML() + `
  <div class="content">
    ${pgHeadHTML()}
    ${kpiHTML(t)}
    ${filterHTML(list)}
    <div class="split">
      <div class="mapcard" id="mapcard">
        <div id="map"></div>
        <div class="mctl tl"><div class="jump" id="jump">
          <button data-fit="foot">Fit footprint</button><button data-fit="us">CONUS</button>
          <button data-fit="AK">AK</button><button data-fit="HI">HI</button><button data-fit="PR">PR</button>
        </div></div>
        <div class="mctl tr">
          <div class="mgrp"><button id="zin" aria-label="Zoom in">${I.plus}</button><button id="zout" aria-label="Zoom out">${I.minus}</button></div>
          <div class="sel" id="layersSel"><button class="mbtn" id="layersBtn" aria-label="Map layers">${I.layers}</button></div>
        </div>
        <div class="mctl br">${legendHTML()}</div>
        <div class="attrib" id="attrib">Boundaries · U.S. Census Bureau, 119th Congress</div>
      </div>
      <div class="rail" id="rail"></div>
    </div>
  </div>`;
  wireTopbar(); wireFilters(); renderRail(list);
  $('#zin').onclick = () => mapObj && mapObj.zoomIn();
  $('#zout').onclick = () => mapObj && mapObj.zoomOut();
  $('#layersBtn').onclick = (e) => { e.stopPropagation(); layersPop(); };
  $('#jump').querySelectorAll('[data-fit]').forEach(b => b.onclick = () => fitTo(b.dataset.fit, list));
  initMap(list);
  if (S.view === 'future') futureBanner();
  if (S.selected) openDrawer(S.selected);
}

function topbarHTML() {
  return `<div class="topbar">
    <div class="crumbs"><button data-nav2="nexus">Intelligence</button><span class="sep">/</span><b>District Nexus</b>
      <span class="chip tag" style="margin-left:2px;background:var(--violet-soft);border-color:transparent;color:var(--violet)">district_nexus_v2</span></div>
    <div class="rt">
      <div class="sel" id="dqSel"><button class="dn-select alarm" id="dqBtn">${I.warn}<span class="lab">Data quality</span><span class="val">3</span>${I.cv}</button></div>
      <div class="sel" id="freshSel"><button class="dn-select" id="freshBtn">${I.clock}<span class="lab">Freshness</span><span class="val">8 rails</span>${I.cv}</button></div>
      <button class="btn sm" id="mapBtn">Manage mappings</button>
      <button class="btn sm" id="expBtn">Export</button>
    </div>
  </div>`;
}
function wireTopbar() {
  const b = $('#mapBtn'); if (b) b.onclick = () => { S.route = 'mappings'; closeDrawer(); render(); };
  const e2 = $('#expBtn'); if (e2) e2.onclick = () => toast('Export stays gated until the core experience is stable (§3.2).');
  const c = $('#main').querySelector('[data-nav2]'); if (c) c.onclick = () => { S.route = 'nexus'; render(); };
  const f = $('#freshBtn');
  if (f) f.onclick = (ev) => {
    ev.stopPropagation();
    popover($('#freshSel'), `<div class="mh">Source freshness — SyncRun watermarks</div>` +
      FRESHNESS.map(x => `<div class="opt" style="cursor:default;align-items:flex-start">
        <span class="dot" style="background:var(--success);margin-top:6px"></span>
        <div><div>${esc(x.rail)}</div><div class="mono" style="font-size:10.5px;color:var(--ink-3)">${esc(x.job)} · ${ago(x.at)}</div></div></div>`).join(''), true);
  };
  const dq = $('#dqBtn');
  if (dq) dq.onclick = (ev) => {
    ev.stopPropagation();
    const rd = DISTRICTS.filter(x => x.futureChange).length;
    popover($('#dqSel'), `<div class="mh">Data quality — whole footprint</div>
      <div style="padding:2px 8px 8px;width:312px;display:flex;flex-direction:column;gap:8px">
        <div class="hint notable"><span class="hico">${I.warn}</span><div><b>$16.7M of awarded funding is unplaced.</b> Statewide, undefined or unreported place of performance — never split across districts.</div></div>
        <div class="hint notable"><span class="hico">${I.warn}</span><div><b>1 facility geocode is ambiguous.</b> WV-02 is provisional; facility weight is halved.</div></div>
        <div class="hint"><span class="hico">${I.info}</span><div><b>Award CD vintage: as-reported.</b> USAspending reports the district as of the award date; the map is 119th-Congress geometry.</div></div>
        <div class="hint info"><span class="hico">${I.info}</span><div><b>${rd} districts are redistricted for 2027.</b> Current members are never described as officeholders of the redrawn districts.</div></div>
      </div>`, true);
  };
}
function pgHeadHTML() {
  return `<div class="pg-head">
    <div><h1 class="pg-title">District Nexus</h1>
      <p class="pg-desc">Verified client footprint, public funding and representation by congressional district.</p></div>
    <div class="acts">
      <div class="seg-toggle" role="group" aria-label="Boundary vintage">
        <button class="${S.view === 'current' ? 'on' : ''}" data-view="current">Current · 119th</button>
        <button class="${S.view === 'future' ? 'on' : ''}" data-view="future" ${S.futureAvailable ? '' : 'disabled title="No enacted-future boundary artifact has been built yet — enable it in the States panel to preview."'}>Enacted future</button>
      </div>
    </div>
  </div>`;
}

function kpiHTML(t) {
  const list = t._list || [];
  const states = new Set(list.map(d => d.k.slice(0, 2))).size;
  const amb = list.reduce((a, d) => a + d.rows.filter(r => r.geocode !== 'matched').length, 0);
  const cov = t.districts ? Math.round(100 * (t.districts - t.empUnknown) / t.districts) : 100;
  return `<div class="kpis">
    <div class="kgrp">
      <div class="kpi"><div class="k">Districts</div><div class="v">${t.districts}</div>
        <div class="s">${t.clients.size} client${t.clients.size === 1 ? '' : 's'} · ${states} state${states === 1 ? '' : 's'}</div></div>
      <div class="kpi"><div class="k">Facilities</div><div class="v">${t.facilities}</div>
        <div class="s">${amb ? `<b>${amb} geocode ambiguous</b>` : 'all geocodes resolved'}</div></div>
      <div class="kpi"><div class="k">Employees</div><div class="v">${num(t.employees)}</div>
        <div class="s">${t.empUnknown ? `<b>${t.empUnknown} district${t.empUnknown > 1 ? 's' : ''} not reported</b>` : cov + '% coverage'}</div></div>
      <div class="kpi"><div class="k">Contracts</div><div class="v">${money(t.contracts)}</div>
        <div class="s">DoD prime · ${t.unmappedC ? `<b>${money(t.unmappedC)} unplaced</b>` : 'fully placed'}</div></div>
      <div class="kpi"><div class="k">Grants</div><div class="v">${money(t.grants)}</div>
        <div class="s">${money(t.outlays)} outlaid${t.unmappedG ? ` · <b>${money(t.unmappedG)} unplaced</b>` : ''}</div></div>
    </div>
    <div class="kgrp opp" title="Opportunities are never added to awarded-dollar totals">
      <div class="kpi"><div class="k">Opportunities · not awarded</div><div class="v">${t.opps}</div>
        <div class="s">${money(t.oppEst, 0)} est. program funding</div></div>
    </div>
  </div>`;
}

function legendHTML() {
  const sc = SCALES[S.metric];
  return `<div class="legend">
    <div class="lt">${esc(sc.label)}</div>
    <div class="ramp">${RAMP.map(c => `<i style="background:${c}"></i>`).join('')}</div>
    <div class="sc">${sc.ticks.map(x => `<span>${x}</span>`).join('')}</div>
    <div class="ex">
      <div><span class="sw" style="background:#e8e4da"></span>No verified nexus</div>
      <div><span class="sw" style="background:repeating-linear-gradient(135deg,#d8d2c4 0 3px,#fff 3px 6px)"></span>Unplaced funding — not on map</div>
      ${S.showFacilities ? `<div><span class="sw" style="border-radius:50%;width:11px;background:#fff;border:2px solid #1a3f9f"></span>Client facilities (district centroid)</div>` : ''}
    </div>
  </div>`;
}

/* ── filters ───────────────────────────────────────── */
const AGENCIES = ['Defense','Health and Human Services','Energy','Commerce','Agriculture','Environmental Protection Agency','National Science Foundation'];
const TYPES = [['facility','Facility'],['employee','Employees'],['contract','Contracts'],['grant','Awarded grants'],['target','Targets']];
const METRICS = [['nexus','Nexus strength'],['contracts','Contract obligations'],['grants','Grant obligations'],['employees','Employees'],['clients','Clients'],['coverage','Evidence coverage']];
const SORTS = [['nexus','Nexus strength'],['contracts','Contract obligations'],['grants','Grant obligations'],['employees','Employees'],['coverage','Evidence coverage'],['key','District code']];

function filterHTML(list) {
  const chips = [];
  if (S.client) chips.push(['client', CLIENT_BY_ID[S.client].short]);
  if (S.nexusTypes.length < TYPES.length) chips.push(['types', S.nexusTypes.length + ' of ' + TYPES.length + ' nexus types']);
  if (S.agencies.length) chips.push(['agencies', S.agencies.length === 1 ? S.agencies[0] : S.agencies.length + ' agencies']);
  if (S.minAmount) chips.push(['min', '≥ ' + money(S.minAmount, 0)]);
  if (!S.includeInferred) chips.push(['inf', 'Verified evidence only']);
  return `<div class="fbar">
    <div class="sel" id="selClient"><button class="dn-select"><span class="lab">Client</span><span class="val">${S.client ? esc(CLIENT_BY_ID[S.client].short) : 'All'}</span>${I.cv}</button></div>
    <div class="sel" id="selMetric"><button class="dn-select"><span class="lab">Colour by</span><span class="val">${esc(METRICS.find(m => m[0] === S.metric)[1])}</span>${I.cv}</button></div>
    <div class="sel" id="selTypes"><button class="dn-select"><span class="lab">Nexus type</span><span class="val">${S.nexusTypes.length === TYPES.length ? 'All' : S.nexusTypes.length + ' selected'}</span>${I.cv}</button></div>
    <div class="sel" id="selAg"><button class="dn-select"><span class="lab">Agency</span><span class="val">${S.agencies.length ? (S.agencies.length === 1 ? esc(S.agencies[0].split(' ')[0]) : S.agencies.length + ' selected') : 'All'}</span>${I.cv}</button></div>
    <div class="sel" id="selMore"><button class="dn-select"><span class="val">More filters</span>${I.cv}</button></div>
    <span class="dn-select" style="cursor:default"><span class="lab">FY</span><span class="val">2025 – 2026</span></span>
    ${chips.map(c => `<span class="fchip" data-chip="${c[0]}">${esc(c[1])}<button aria-label="Remove filter">${I.x}</button></span>`).join('')}
    <div class="rt"><span class="num" style="font-weight:600;color:var(--ink-2)">${list.length}</span> districts
      ${chips.length ? `<button class="link-btn" id="clrF">Clear all</button>` : ''}</div>
  </div>`;
}
function wireFilters() {
  const mk = (host, html, right) => { $(host + ' .dn-select').onclick = (e) => { e.stopPropagation(); const p = popover($(host), html, right); if (p) wirePop(p); }; };
  mk('#selClient', `<div class="mh">Client</div><div class="opt${S.client ? '' : ' sel'}" data-set="client" data-v="">All clients<span class="rt">${DISTRICTS.length}</span></div><div class="mdv"></div>` +
    CLIENTS.map(c => `<div class="opt${S.client === c.id ? ' sel' : ''}" data-set="client" data-v="${c.id}">${esc(c.name)}<span class="rt">${esc(c.sector.split(' ')[0])}</span></div>`).join(''));
  mk('#selMetric', `<div class="mh">Choropleth metric</div>` + METRICS.map(m => `<div class="opt${S.metric === m[0] ? ' sel' : ''}" data-set="metric" data-v="${m[0]}">${m[1]}</div>`).join('') +
    `<div class="mdv"></div><div class="mh" style="white-space:normal;max-width:236px;line-height:1.5;text-transform:none;letter-spacing:0;font-weight:500">Opportunity ceiling is deliberately not offered as a map metric.</div>`);
  mk('#selTypes', `<div class="mh">Nexus type</div>` + TYPES.map(t => `<div class="opt${S.nexusTypes.includes(t[0]) ? ' sel' : ''}" data-tog="type" data-v="${t[0]}"><span class="ck">${I.ck}</span>${t[1]}</div>`).join(''));
  mk('#selAg', `<div class="mh">Awarding agency</div>` + AGENCIES.map(a => `<div class="opt${S.agencies.includes(a) ? ' sel' : ''}" data-tog="agency" data-v="${esc(a)}"><span class="ck">${I.ck}</span>${esc(a)}</div>`).join(''));
  mk('#selMore', `<div class="mh">Minimum public funding</div>` +
    [[0,'Any'],[1e6,'≥ $1M'],[5e6,'≥ $5M'],[1e7,'≥ $10M']].map(x => `<div class="opt${S.minAmount === x[0] ? ' sel' : ''}" data-set="minAmount" data-v="${x[0]}" data-numeric="1">${x[1]}</div>`).join('') +
    `<div class="mdv"></div><div class="mh">Evidence</div>
     <div class="opt${S.includeInferred ? ' sel' : ''}" data-tog="inferred" data-v="1"><span class="ck">${I.ck}</span>Include inferred / recipient-location</div>
     <div class="mdv"></div><div class="mh">Sort list by</div>` +
    SORTS.map(x => `<div class="opt${S.sort === x[0] ? ' sel' : ''}" data-set="sort" data-v="${x[0]}">${x[1]}</div>`).join(''), true);

  function wirePop(p) {
    p.querySelectorAll('[data-set]').forEach(o => o.onclick = () => {
      const v = o.dataset.v;
      S[o.dataset.set] = o.dataset.numeric ? +v : (v === '' ? null : v);
      S.selected = null; S.filterKeys = null; closePop(); closeDrawer(); render();
    });
    p.querySelectorAll('[data-tog]').forEach(o => o.onclick = (e) => {
      e.stopPropagation();
      const k = o.dataset.tog, v = o.dataset.v;
      if (k === 'inferred') S.includeInferred = !S.includeInferred;
      else { const arr = k === 'type' ? S.nexusTypes : S.agencies; const i = arr.indexOf(v); if (i >= 0) arr.splice(i, 1); else arr.push(v); }
      render();
    });
  }
  $('#main').querySelectorAll('[data-chip] button').forEach(b => b.onclick = () => {
    const k = b.parentElement.dataset.chip;
    if (k === 'client') S.client = null;
    if (k === 'types') S.nexusTypes = TYPES.map(t => t[0]);
    if (k === 'agencies') S.agencies = [];
    if (k === 'min') S.minAmount = 0;
    if (k === 'inf') S.includeInferred = true;
    S.selected = null; S.filterKeys = null; closeDrawer(); render();
  });
  const c = $('#clrF');
  if (c) c.onclick = () => { S.client = null; S.nexusTypes = TYPES.map(t => t[0]); S.agencies = []; S.minAmount = 0;
    S.includeInferred = true; S.selected = null; S.filterKeys = null; closeDrawer(); render(); };
}
function layersPop() {
  const p = popover($('#layersSel'), `<div class="mh">Layers</div>
    <div class="opt${S.showFacilities ? ' sel' : ''}" data-l="fac"><span class="ck">${I.ck}</span>Client facilities</div>
    <div class="opt${S.basemap ? ' sel' : ''}" data-l="base"><span class="ck">${I.ck}</span>OpenStreetMap basemap</div>`, true);
  if (!p) return;
  p.querySelectorAll('[data-l]').forEach(o => o.onclick = (e) => {
    e.stopPropagation();
    if (o.dataset.l === 'fac') S.showFacilities = !S.showFacilities; else S.basemap = !S.basemap;
    closePop(); render();
  });
}

/* ── findings ──────────────────────────────────────── */
function findings(list) {
  const out = [];
  const gap = list.filter(d => (d.contracts.obl + d.grants.obl) >= 1e6 && !d.targets.length && d.rows.length);
  if (gap.length) out.push({c:'var(--notable)',
    html:`<em>${gap.length} district${gap.length === 1 ? '' : 's'}</em> carr${gap.length === 1 ? 'ies' : 'y'} a verified facility and ≥$1M in federal funding but ha${gap.length === 1 ? 's' : 've'} <em>no logged target or outreach</em>.`,
    act:gap.length === 1 ? 'Show this district' : 'Show these districts',
    run:() => { S.filterKeys = gap.map(d => d.k); render(); }});
  const un = UNPLACED.filter(x => !S.client || x.c === S.client).reduce((a, x) => a + x.obl, 0) +
             UNPLACED_CONTRACTS.filter(x => !S.client || x.c === S.client).reduce((a, x) => a + x.obl, 0);
  if (un) out.push({c:'var(--accent)',
    html:`<em>${money(un)}</em> of awarded funding cannot be placed in a district — statewide, undefined or unreported place of performance.`,
    act:'Review unplaced funding', run:openUnplaced});
  const fc = DISTRICTS.filter(d => d.futureChange && list.some(x => x.k === d.k));
  if (fc.length) out.push({c:'var(--violet)',
    html:`<em>${fc.length} district${fc.length === 1 ? '' : 's'}</em> in your footprint change under enacted 2027 maps in <em>CA</em> and <em>TX</em>, effective Jan 3, 2027.`,
    act:'See affected districts', run:() => { S.filterKeys = fc.map(d => d.k); render(); }});
  if (!out.length) out.push({c:'var(--success)',
    html:`No unplaced funding, ambiguous geography or redistricting exposure in this filter set.`,
    act:'Everything here is placed and current', run:() => {}});
  return out;
}

/* ── right rail ────────────────────────────────────── */
function renderRail(list) {
  const f = findings(list);
  const shown = S.filterKeys ? list.filter(d => S.filterKeys.includes(d.k)) : list;
  const unC = UNPLACED_CONTRACTS.filter(x => !S.client || x.c === S.client).reduce((a, x) => a + x.obl, 0);
  const unG = UNPLACED.filter(x => !S.client || x.c === S.client).reduce((a, x) => a + x.obl, 0);
  $('#rail').innerHTML = `
    <div class="findings${S.findingsClosed ? ' cl' : ''}" id="findings">
      <div class="fh" id="fhd" role="button" tabindex="0">Findings<span class="cnt">${f.length}</span><span class="cv">${I.cv}</span></div>
      <div class="fl">${f.map((x, i) => `<div class="fi" data-f="${i}" role="button" tabindex="0">
        <span class="fd" style="background:${x.c}"></span>
        <div><div class="tx">${x.html}</div><div class="act">${esc(x.act)} ${I.ar}</div></div></div>`).join('')}</div>
    </div>
    <div class="lhead">
      <span class="t">Districts <span class="c">${shown.length}${S.filterKeys ? '/' + list.length : ''}</span></span>
      ${S.filterKeys ? `<button class="link-btn" id="clrFind">Clear finding</button>` : ''}
      <span class="so">by ${esc((SORTS.find(s => s[0] === S.sort) || SORTS[0])[1].toLowerCase())}</span>
    </div>
    <div class="dlist" id="dlist" role="list">${shown.length ? shown.map(rowHTML).join('') : emptyListHTML()}</div>
    ${unC + unG ? `<div class="rfoot" id="unfoot" role="button" tabindex="0">
      <span style="color:var(--notable);display:grid;place-items:center">${I.warn}</span>
      <span class="tt">Unplaced funding <b>${money(unC + unG)}</b> · ${money(unC)} contracts, ${money(unG)} grants</span>
      <span class="ar">${I.ar}</span></div>` : ''}`;
  $('#fhd').onclick = () => { S.findingsClosed = !S.findingsClosed; $('#findings').classList.toggle('cl'); };
  $('#rail').querySelectorAll('[data-f]').forEach(x => x.onclick = () => f[+x.dataset.f].run());
  const cf = $('#clrFind'); if (cf) cf.onclick = (e) => { e.stopPropagation(); S.filterKeys = null; render(); };
  const uf = $('#unfoot'); if (uf) uf.onclick = openUnplaced;
  $('#dlist').querySelectorAll('[data-k]').forEach(r => {
    r.onclick = () => selectDistrict(r.dataset.k);
    r.onmouseenter = () => highlight(r.dataset.k, true);
    r.onmouseleave = () => highlight(r.dataset.k, false);
    r.onkeydown = (e) => { if (e.key === 'Enter') selectDistrict(r.dataset.k); };
  });
}
function rowHTML(d) {
  const b = bandOf(d.score);
  return `<div class="drow${S.selected === d.k ? ' sel' : ''}" data-k="${d.k}" role="listitem" tabindex="0">
    <div class="r1"><span class="dk">${d.k}</span><span class="dm">${esc(d.house[0])} (${d.house[1]})</span>
      <span class="band" style="color:${b[2]}">${b[1]}</span></div>
    <div class="r2">${ebar(d)}<span class="sc">${d.score}</span></div>
    <div class="r3">${evidenceChips(d, 4)}</div>
    <div class="r4">
      <div><span>Contracts</span> <b>${d.contracts.obl ? money(d.contracts.obl) : '—'}</b></div>
      <div><span>Grants</span> <b>${d.grants.obl ? money(d.grants.obl) : '—'}</b></div>
      <div><span>Emp</span> <b>${d.employees ? num(d.employees) : (d.rows.length ? 'n/r' : '—')}</b></div>
    </div>
  </div>`;
}
const emptyListHTML = () => `<div style="padding:40px 24px;text-align:center">
  <div style="width:44px;height:44px;border-radius:50%;background:var(--bg-sunken);color:var(--ink-4);display:grid;place-items:center;margin:0 auto 12px">${I.search}</div>
  <div style="font-size:13.5px;font-weight:600;margin-bottom:5px">No districts match these filters</div>
  <div style="font-size:12.5px;color:var(--ink-3);line-height:1.55">Nothing was hidden by an error — the filter set simply has no results.</div></div>`;

/* ── map ───────────────────────────────────────────── */
const GEO_URL = 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Legislative/MapServer/0/query?' +
  new URLSearchParams({where:'1=1', outFields:'STATE,CD119,BASENAME', returnGeometry:'true', f:'geojson',
                       outSR:'4326', maxAllowableOffset:'0.02', geometryPrecision:'4', resultRecordCount:'500'});
const CACHE_KEY = 'capiro.dn.cd119.v1';
const CONUS = [[24.4, -125.2], [49.6, -66.8]];

function keyOf(p) {
  const st = FIPS[p.STATE];
  if (!st || p.CD119 == null) return null;
  return st + '-' + String(p.CD119).padStart(2, '0');
}
function initMap(list) {
  if (S.pageState === 'maperror') { mapFailure(list); return; }
  if (mapObj) { try { mapObj.remove(); } catch (e) {} mapObj = null; }
  mapObj = L.map('map', {preferCanvas:false, zoomControl:false, attributionControl:false,
                         minZoom:2, maxZoom:11, zoomSnap:.25, wheelPxPerZoomLevel:140});
  mapObj.fitBounds(CONUS, {padding:[10, 10], animate:false});
  if (S.basemap) {
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {attribution:'© OpenStreetMap contributors', opacity:.5}).addTo(mapObj);
    $('#attrib').textContent = '© OpenStreetMap contributors · Boundaries · U.S. Census Bureau, 119th Congress';
  }
  if (GEO) drawGeo(list); else loadGeo();
}
function loadGeo() {
  let cached = null;
  try { cached = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null'); } catch (e) {}
  if (cached && cached.features) { GEO = cached; drawGeo(activeDistricts()); return; }
  const ov = el(`<div id="geoload" style="position:absolute;inset:0;z-index:650;display:grid;place-items:center;background:rgba(236,234,227,.92)">
    <div style="text-align:center"><div class="skel" style="width:130px;height:8px;margin:0 auto 13px"></div>
    <div style="font-size:12.5px;color:var(--ink-2);font-weight:500">Loading boundary artifact</div>
    <div class="mono" style="font-size:11px;color:var(--ink-3);margin-top:4px">census cartographic · 119th Congress · 444 features</div></div></div>`);
  $('#mapcard').appendChild(ov);
  /* In the standalone export the artifact is inlined and served from a blob URL. */
  const src = (window.__resources && window.__resources.cd119) || GEO_URL;
  fetch(src).then(r => r.json()).then(j => {
    if (!j.features || !j.features.length) throw new Error('empty');
    GEO = j;
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(j)); } catch (e) {}
    const o = $('#geoload'); if (o) o.remove();
    drawGeo(activeDistricts());
  }).catch(() => { const o = $('#geoload'); if (o) o.remove(); mapFailure(activeDistricts(), true); });
}
function drawGeo(list) {
  if (!mapObj || !GEO) return;
  const set = Object.fromEntries(list.map(d => [d.k, d]));
  const futureKeys = new Set(DISTRICTS.filter(d => d.futureChange).map(d => d.k));
  if (geoLayer) geoLayer.remove();
  geoLayer = L.geoJSON(GEO, {
    style: (f) => {
      const k = keyOf(f.properties), d = k && set[k];
      if (!d) return {fillColor:'#e8e4da', fillOpacity:S.basemap ? .3 : .95, color:'#dcd7cb', weight:.4};
      return {fillColor:rampColor(metricValue(d)), fillOpacity:S.basemap ? .74 : .96, color:'#12306e', weight:.7, opacity:.42};
    },
    onEachFeature: (f, layer) => {
      const k = keyOf(f.properties); if (!k) return;
      layer._dnKey = k;
      layer.on('mouseover', (e) => { hoverCard(k, set[k], e); highlight(k, true, true); layer.setStyle({weight:2, color:'#1a3f9f', opacity:1}); layer.bringToFront(); });
      layer.on('mousemove', moveHover);
      layer.on('mouseout', () => { killHover(); highlight(k, false, true); geoLayer.resetStyle(layer); restyleSelected(); });
      layer.on('click', () => set[k] ? selectDistrict(k) : toast(k + ' has no verified client nexus under the current filters.'));
      if (S.view === 'future' && !futureKeys.has(k)) layer.setStyle({fillOpacity:.2, fillColor:'#d8d2c4'});
    }
  }).addTo(mapObj);
  drawFacilities(list);
  restyleSelected();
  setTimeout(() => {
    if (!mapObj) return;
    mapObj.invalidateSize();
    if (S.client) fitTo('foot', list); else mapObj.fitBounds(CONUS, {padding:[10, 10], animate:false});
  }, 120);
}
function drawFacilities(list) {
  if (facLayer) { facLayer.remove(); facLayer = null; }
  if (!S.showFacilities || !geoLayer) return;
  const marks = [];
  list.filter(d => d.facilities).forEach(d => {
    let c = null;
    geoLayer.eachLayer(l => { if (l._dnKey === d.k && !c) c = l.getBounds().getCenter(); });
    if (!c) return;
    marks.push(L.circleMarker(c, {radius:4 + Math.min(9, Math.sqrt((d.employees || 60) / 40)),
        color:'#1a3f9f', weight:2, fillColor:'#ffffff', fillOpacity:.95})
      .on('click', () => selectDistrict(d.k))
      .bindTooltip(`<b>${d.k}</b> · ${d.facilities} facilit${d.facilities > 1 ? 'ies' : 'y'}${d.employees ? ' · ' + num(d.employees) + ' emp' : ''}<br><span style="opacity:.7">Aggregated to district centroid</span>`, {direction:'top'}));
  });
  facLayer = L.layerGroup(marks).addTo(mapObj);
}
function restyleSelected() {
  if (!geoLayer) return;
  geoLayer.eachLayer(l => { if (l._dnKey === S.selected) { l.setStyle({weight:2.6, color:'#1a3f9f', opacity:1}); l.bringToFront(); } });
}
let hovEl = null;
function hoverCard(k, d, e) {
  killHover();
  const b = d && bandOf(d.score);
  hovEl = el(`<div class="hovcard">
    <div class="hk">${k}${d ? `<span style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;font-family:var(--font-sans);color:${b[2]}">${b[1]} ${d.score}</span>` : ''}</div>
    <div class="hm">${d ? esc(d.house[0]) + ' (' + d.house[1] + ')' : 'No verified client nexus'}</div>
    ${d ? `<div class="hr"><span>Contracts</span><b>${d.contracts.obl ? money(d.contracts.obl) : '—'}</b></div>
           <div class="hr"><span>Grants</span><b>${d.grants.obl ? money(d.grants.obl) : '—'}</b></div>
           <div class="hr"><span>Employees</span><b>${d.employees ? num(d.employees) : (d.rows.length ? 'not rep.' : '—')}</b></div>`
        : `<div class="hr" style="color:var(--ink-3)">Click districts with nexus for detail</div>`}
  </div>`);
  $('#mapcard').appendChild(hovEl); moveHover(e);
}
function moveHover(e) {
  if (!hovEl || !e.containerPoint) return;
  const w = $('#mapcard').clientWidth, h = $('#mapcard').clientHeight;
  let x = e.containerPoint.x + 14, y = e.containerPoint.y + 14;
  if (x + 214 > w) x = e.containerPoint.x - 214;
  if (y + 134 > h) y = e.containerPoint.y - 134;
  hovEl.style.left = Math.max(4, x) + 'px'; hovEl.style.top = Math.max(4, y) + 'px';
}
function killHover() { if (hovEl) { hovEl.remove(); hovEl = null; } }
function highlight(k, on, fromMap) {
  const dl = $('#dlist');
  const r = dl && dl.querySelector(`[data-k="${k}"]`);
  if (r) r.classList.toggle('hl', on);
  if (!fromMap && geoLayer) geoLayer.eachLayer(l => {
    if (l._dnKey !== k) return;
    if (on) { l.setStyle({weight:2.2, color:'#1a3f9f', opacity:1}); l.bringToFront(); }
    else { geoLayer.resetStyle(l); restyleSelected(); }
  });
}
function fitTo(what, list) {
  if (!mapObj) return;
  const V = {us:CONUS, AK:[[51, -170], [71.5, -129]], HI:[[18.6, -160.4], [22.4, -154.6]], PR:[[17.8, -67.4], [18.6, -65.2]]};
  if (what === 'foot') {
    if (!geoLayer) return;
    const keys = new Set((list || activeDistricts()).map(d => d.k));
    let bb = null;
    geoLayer.eachLayer(l => { if (keys.has(l._dnKey)) bb = bb ? bb.extend(l.getBounds()) : L.latLngBounds(l.getBounds().getSouthWest(), l.getBounds().getNorthEast()); });
    if (bb) mapObj.fitBounds(bb, {padding:[36, 36], maxZoom:6.5, animate:false});
    return;
  }
  mapObj.fitBounds(V[what], {padding:[20, 20], animate:false});
}
function mapFailure(list, runtime) {
  const w = $('#mapcard'); if (!w) return;
  if (mapObj) { try { mapObj.remove(); } catch (e) {} mapObj = null; }
  const L2 = list || activeDistricts();
  w.innerHTML = `<div style="position:absolute;inset:0;display:flex;flex-direction:column;background:var(--bg-surface)">
    <div class="hint notable" style="border-radius:0;border-left:0;border-right:0;border-top:0;padding:12px 16px">
      <span class="hico">${I.warn}</span>
      <div><b>Boundary map unavailable.</b> ${runtime ? 'The boundary artifact could not be fetched.' : 'WebGL is unavailable in this browser session.'}
      Every number, filter and district below is unaffected — the map is a view of this data, not its source.
      <div style="margin-top:7px"><button class="btn sm" id="retryMap">Retry map</button></div></div>
    </div>
    <div style="flex:1;overflow:auto" id="ftbl"></div></div>`;
  $('#retryMap').onclick = () => { S.pageState = 'normal'; GEO = null; render(); };
  $('#ftbl').innerHTML = `<table class="htable"><thead><tr>
      <th>District</th><th>Representative</th><th>Evidence</th><th class="n">Contracts</th><th class="n">Grants</th><th class="n">Emp</th><th class="n">Nexus</th></tr></thead><tbody>` +
    L2.map(d => `<tr data-k="${d.k}" style="cursor:pointer"><td class="mono" style="font-weight:700">${d.k}</td>
      <td>${esc(d.house[0])} <span class="sub">(${d.house[1]})</span></td>
      <td style="max-width:220px"><div style="display:flex;gap:4px;flex-wrap:wrap">${evidenceChips(d, 3)}</div></td>
      <td class="n">${d.contracts.obl ? money(d.contracts.obl) : '—'}</td>
      <td class="n">${d.grants.obl ? money(d.grants.obl) : '—'}</td>
      <td class="n">${d.employees ? num(d.employees) : (d.rows.length ? 'n/r' : '—')}</td>
      <td class="n"><b style="color:${bandOf(d.score)[2]}">${d.score}</b></td></tr>`).join('') + `</tbody></table>`;
  $('#ftbl').querySelectorAll('[data-k]').forEach(r => r.onclick = () => selectDistrict(r.dataset.k));
}
function futureBanner() {
  const n = el(`<div style="position:absolute;top:12px;left:50%;transform:translateX(-50%);z-index:640;max-width:520px">
    <div class="hint info" style="box-shadow:var(--shadow-2)"><span class="hico">${I.info}</span>
    <div><b>Enacted future boundaries — effective Jan 3, 2027.</b> The artifact covers CA and TX only; every other district is dimmed at its current geometry.
    Current members are <b>not</b> presented as officeholders of the redrawn districts.</div></div></div>`);
  const mc = $('#mapcard'); if (mc) mc.appendChild(n);
}

/* ── selection + drawer ────────────────────────────── */
function closeDrawer() { $('#drawer').classList.remove('on'); $('#veil').classList.remove('on'); }
function selectDistrict(k) {
  S.selected = k;
  if (!k) { closeDrawer(); restyleSelected(); const dl = $('#dlist'); if (dl) dl.querySelectorAll('.drow').forEach(r => r.classList.remove('sel')); return; }
  openDrawer(k);
  if (geoLayer) { geoLayer.eachLayer(l => geoLayer.resetStyle(l)); restyleSelected(); }
  const dl = $('#dlist');
  if (dl) dl.querySelectorAll('.drow').forEach(r => r.classList.toggle('sel', r.dataset.k === k));
}
const sect = (title, meta, body) =>
  `<div class="sec"><div class="sh"><span class="st">${esc(title)}</span><span class="sm">${esc(meta)}</span><span class="cv">${I.cv}</span></div><div class="sb">${body}</div></div>`;

function openDrawer(k) {
  const base = byKey[k]; if (!base) return;
  const d = Object.assign({}, base, scoreDistrict(base, S.client ? [S.client] : null));
  const b = bandOf(d.score);
  const sen = SENATORS[k.slice(0, 2)] || [];
  const aw = AWARDS.filter(a => a.d === k && (!S.client || a.c === S.client));
  const opp = OPPS.filter(o => d.clients.includes(o.client) && (!S.client || o.client === S.client));
  const warns = [];
  if (d.contracts.basis === 'recipient_location' || d.grants.basis === 'recipient_location')
    warns.push(['notable', 'Recipient location, not place of performance', 'Some funding here is placed by recipient headquarters address. It contributes reduced weight and must not be described as district impact.']);
  if (d.rows.some(r => r.geocode !== 'matched'))
    warns.push(['notable', 'Ambiguous facility geocode', 'One facility address returned an ambiguous Census Geocoder match. The district assignment is provisional and facility weight is halved.']);
  if (d.futureChange)
    warns.push(['info', 'Boundary changes Jan 3, 2027', 'An enacted future map redraws this district. Current representation below applies to the 119th Congress geometry only.']);
  if (d.note) warns.push(['notable', 'Limited evidence basis', d.note]);
  warns.push(['', 'Award CD vintage: as-reported (original)', 'USAspending reports the district as of the award date. The map is 119th-Congress geometry. Alignment is confident for awards after Jan 2023.']);

  $('#drawer').innerHTML = `
    <div class="dr-head">
      <div class="dr-kicker">Congressional district</div>
      <div class="l1"><h2>${d.k}</h2><span class="nmx">${esc(d.name)}</span>
        <button class="dr-x" id="dclose" aria-label="Close">${I.x}</button></div>
      <div class="l2">
        <span class="pill ${d.score >= 60 ? 'info' : 'muted'}">${b[1]} nexus · ${d.score}</span>
        <span class="chip muted">Coverage ${d.coverage}%</span>
        <span class="chip muted">Boundary: current, 119th</span>
        ${d.futureChange ? `<span class="pill violet">Redistricted 2027</span>` : ''}
      </div>
      <div class="l3">
        <button class="btn sm" data-go="/directory/districts/${d.k.slice(0,2)}/${d.k.slice(3)}">Open district page ${I.ext}</button>
        <button class="btn sm btn-accent" id="briefBtn">Add to brief</button>
        <button class="btn sm btn-ghost" data-go="/explorer?source=federal-assistance-awards&district=${d.k}">View awards in Explorer</button>
      </div>
    </div>
    <div class="dr-body">
      <div class="sec"><div class="sb" style="padding-top:15px">${warns.map(w =>
        `<div class="hint ${w[0]}"><span class="hico">${w[0] === 'notable' ? I.warn : I.info}</span><div><b>${esc(w[1])}</b><br>${esc(w[2])}</div></div>`).join('')}</div></div>

      ${sect('Why this score', d.score + ' / 100', `
        <div class="bkd">${d.breakdown.map(x => `
          <div class="br${x.credited ? '' : ' z'}">
            <div class="bl"><span class="sw" style="background:${x.credited ? x.color : '#e2ddd2'}"></span>
              <span class="nm" title="${esc(x.note)}">${esc(x.label)}</span></div>
            <div class="bw"><i style="width:${x.weight ? (x.credited / x.weight) * 100 : 0}%;background:${x.color}"></i></div>
            <div class="bv">${x.credited}/${x.weight}</div></div>`).join('')}</div>
        <div style="margin-top:12px" class="hint"><span class="hico">${I.info}</span><div>
          <b>${d.coverage}% evidence coverage.</b> ${100 - d.coverage} points of the model have no data submitted for this district — that is a gap, not a verified zero.
          Unmeasured: ${d.breakdown.filter(x => !x.has).map(x => x.label.toLowerCase()).join(', ') || 'none'}.</div></div>`)}

      ${sect('Representation', d.futureChange ? 'current geometry' : '', `
        <div class="mem"><span class="pty ${d.house[1]}">${d.house[1]}</span>
          <div><div class="nm">${esc(d.house[0])}</div><div class="ro">U.S. House · ${d.k}</div></div>
          <div class="rt"><button class="link-btn" data-go="/directory?profile=${d.house[2]}">Profile ${I.ext}</button></div></div>
        ${sen.map(s => `<div class="mem"><span class="pty ${s[1]}">${s[1]}</span>
          <div><div class="nm">${esc(s[0])}</div><div class="ro">U.S. Senate · ${d.k.slice(0,2)}</div></div></div>`).join('')}
        <div style="margin-top:11px;font-size:12.5px;color:var(--ink-2)"><span class="src-label">Committee relevance</span>
          <div style="margin-top:4px">${d.policy.jurisdiction ? esc(d.policy.note) : 'No committee assignment of jurisdiction for this client’s programs.'}</div>
          <div style="font-size:11.5px;color:var(--ink-3);margin-top:4px">Assignments: ${d.house[3].map(esc).join(' · ')}</div></div>
        ${d.futureChange ? `<div class="hint info" style="margin-top:11px"><span class="hico">${I.info}</span><div>These members represent the <b>current</b> district. Capiro will not describe them as officeholders of the redrawn district until it takes effect.</div></div>` : ''}`)}

      ${sect('Clients in this district', d.rows.length + ' · ' + d.facilities + ' facilities', d.rows.length ? `
        <div class="tblwrap"><table class="htable"><thead><tr><th>Client</th><th>Role</th><th class="n">Sites</th><th class="n">Employees</th></tr></thead><tbody>
        ${d.rows.map(r => { const c = CLIENT_BY_ID[r.c]; return `<tr>
          <td><b style="font-weight:600">${esc(c.name)}</b><div class="sub">${esc(c.sector)}</div></td>
          <td>${esc(r.role)}<div class="sub">${r.geocode === 'matched' ? 'Geocode: matched · source geocoded' : '<span style="color:var(--notable)">Geocode: ambiguous — provisional</span>'}</div></td>
          <td class="n">${r.fac}</td>
          <td class="n">${r.emp == null ? '<span style="color:var(--ink-3);font-family:var(--font-sans)">not reported</span>' : num(r.emp)}</td></tr>`; }).join('')}
        </tbody></table></div>` :
        `<div class="hint"><span class="hico">${I.info}</span><div>No client facility here. The nexus rests entirely on award geography, which is weaker evidence than a physical site.</div></div>`)}

      ${sect('Federal contract awards', money(d.contracts.obl) + ' · ' + d.contracts.n + ' awards', d.contracts.n ? `
        <dl class="kv">
          <dt>Obligations</dt><dd class="n">${money(d.contracts.obl)}</dd>
          <dt>Awards</dt><dd class="n">${d.contracts.n}</dd>
          <dt>Geography basis</dt><dd>${d.contracts.basis === 'place_of_performance' ? 'Primary place of performance' : '<span style="color:var(--notable)">Recipient location</span>'}</dd>
          <dt>Source scope</dt><dd>DoD prime contracts only (types A–D)</dd>
          <dt>Identity join</dt><dd>Contractor name equality — legacy rail</dd>
        </dl>
        <div class="prov"><b>Source</b> USAspending spending_by_award <b>Updated</b> ${ago('2026-07-25T09:50Z')} <b>Vintage</b> original</div>` :
        `<div style="font-size:12.5px;color:var(--ink-3)">No contract obligations placed in this district.</div>`)}

      ${sect('Awarded federal assistance', money(d.grants.obl) + ' obligated', d.grants.n ? `
        <dl class="kv" style="margin-bottom:12px">
          <dt>Obligations</dt><dd class="n">${money(d.grants.obl)}</dd>
          <dt>Outlays</dt><dd><span class="n">${money(d.grants.outl)}</span> <span style="color:var(--ink-3)">(never summed with obligations)</span></dd>
          <dt>Awards</dt><dd class="n">${d.grants.n}</dd>
          <dt>Geography basis</dt><dd>${d.grants.basis === 'place_of_performance' ? 'Primary place of performance' : '<span style="color:var(--notable)">Recipient location</span>'}</dd>
        </dl>
        ${aw.length ? `<div class="tblwrap"><table class="htable"><thead><tr><th>Award</th><th>Assistance Listing</th><th class="n">Obligated</th></tr></thead><tbody>
          ${aw.map(a => `<tr><td><span class="mono" style="font-size:11.5px">${esc(a.fain)}</span>
            <div class="sub">${esc(a.sub)} · ${esc(a.typeL)}</div></td>
            <td><span class="mono">${esc(a.aln)}</span><div class="sub" style="max-width:158px">${esc(a.alnT)}</div></td>
            <td class="n">${money(a.obl)}<div class="sub" style="font-family:var(--font-mono)">${money(a.outl)} outlaid</div></td></tr>`).join('')}
          </tbody></table></div>` : ''}
        <div class="prov"><b>Source</b> USAspending assistance 02/03/04/05 <b>Identity</b> confirmed UEI mapping <b>Updated</b> ${ago('2026-07-25T07:45Z')}</div>` :
        `<div style="font-size:12.5px;color:var(--ink-3)">No awarded assistance placed in this district.</div>`)}

      ${sect('Grant opportunities', opp.length + ' potential match' + (opp.length === 1 ? '' : 'es'), `
        <div class="hint" style="margin-bottom:10px"><span class="hico">${I.info}</span><div>
          Opportunities are <b>not awarded money</b>. They are excluded from every dollar total and every map metric, and a match is not a statement of eligibility.</div></div>
        ${opp.length ? opp.map(o => `<div class="oppcard">
          <div class="ot">${esc(o.title)}</div>
          <div class="om"><span class="mono">${esc(o.num)}</span><span>${esc(o.agency)}</span><span class="mono">ALN ${esc(o.aln)}</span>
            <span class="pill ${o.doc === 'forecast' ? 'notable' : 'muted'}">${o.doc}</span></div>
          <div style="display:flex;gap:16px;margin-top:8px;font-size:11.5px;flex-wrap:wrap">
            <div><span style="color:var(--ink-3)">Closes</span> ${o.close ? fdate(o.close) : `<b style="color:var(--notable)">${esc(o.closeDesc)}</b>`}</div>
            <div><span style="color:var(--ink-3)">Ceiling</span> ${o.ceiling ? money(o.ceiling, 0) : 'not stated'}</div>
            <div><span style="color:var(--ink-3)">Eligibility</span> <b style="color:${o.elig === 'eligible' ? 'var(--success)' : 'var(--notable)'}">${o.elig.replace('_', ' ')}</b></div>
          </div>
          <div style="margin-top:8px">${o.signals.map(s => `<div class="sig"><span class="b">·</span>${esc(s)}</div>`).join('')}</div>
        </div>`).join('') : `<div style="font-size:12.5px;color:var(--ink-3)">No opportunity is geographically restricted to this district and no client here has a verified applicant link.</div>`}`)}

      ${sect('Targets and relationship', d.targets.length + ' active', d.targets.length ? `
        ${d.targets.map(t => `<div class="mem"><span class="pty ${d.house[1]}">${d.house[1]}</span>
          <div><div class="nm">${esc(t.m)}</div><div class="ro">Target for ${esc(CLIENT_BY_ID[t.c].name)} · last contact ${fdate(t.last)}</div></div></div>`).join('')}
        <div style="font-size:11.5px;color:var(--ink-3);margin-top:9px">Relationship history is context, never geographic proof of impact.</div>` :
        `<div class="hint notable"><span class="hico">${I.warn}</span><div><b>No logged target or outreach</b> despite ${money(d.contracts.obl + d.grants.obl)} of federal funding and ${d.facilities || 'no'} facilit${d.facilities === 1 ? 'y' : 'ies'} here.</div></div>`)}

      ${sect('District demographics', 'ACS 5-year ' + d.acs.year, `
        <dl class="kv">
          <dt>Population</dt><dd class="n">${num(d.acs.pop)}</dd>
          <dt>Median household income</dt><dd class="n">$${num(d.acs.mhi)}</dd>
          <dt>Veterans</dt><dd class="n">${num(d.acs.vet)}</dd>
          <dt>Vintage</dt><dd>${d.acs.year} ACS 5-year · 119th Congress geography</dd>
        </dl>`)}

      ${sect('Evidence and sources', d.breakdown.filter(x => x.has).length + ' rails', `
        <div class="tblwrap"><table class="htable"><thead><tr><th>Rail</th><th>Geography basis</th><th>Verification</th></tr></thead><tbody>
        ${[['Client facilities', d.rows.length ? 'facility' : null, 'client-entered, geocoded'],
           ['Employee aggregate', d.employees ? 'employee_aggregate' : null, d.employees ? 'client-entered' : 'not reported'],
           ['Contract awards', d.contracts.n ? d.contracts.basis : null, 'source-authoritative'],
           ['Assistance awards', d.grants.n ? d.grants.basis : null, 'source-authoritative, UEI-matched'],
           ['Supplier / local spend', null, 'no evidence submitted'],
           ['Partner / beneficiary', null, 'no evidence submitted'],
           ['Representation', 'district', 'source-authoritative']]
          .map(r => `<tr><td>${r[0]}</td>
            <td class="mono" style="font-size:11px">${r[1] || '<span style="color:var(--ink-4);font-family:var(--font-sans)">—</span>'}</td>
            <td class="sub">${r[2]}</td></tr>`).join('')}
        </tbody></table></div>
        <div class="prov"><b>Tenant</b> Hartwell &amp; Reid <b>External use</b> approved claims only <b>Generated</b> just now</div>`)}
    </div>`;

  $('#drawer').classList.add('on'); $('#veil').classList.add('on');
  $('#dclose').onclick = () => selectDistrict(null);
  $('#briefBtn').onclick = () => toast('Added ' + d.k + ' to the district brief. Only approved, source-backed claims are included.');
  $('#drawer').querySelectorAll('[data-go]').forEach(x => x.onclick = () => link(x.dataset.go));
  $('#drawer').querySelectorAll('.sec').forEach((s, i) => {
    const h = $('.sh', s); if (!h) return;
    if (i > 6) s.classList.add('cl');
    h.onclick = () => s.classList.toggle('cl');
  });
  if (mapObj && geoLayer) {
    let bb = null; geoLayer.eachLayer(l => { if (l._dnKey === k) bb = l.getBounds(); });
    const mw = $('#mapcard') ? $('#mapcard').clientWidth : 800;
    if (bb) mapObj.fitBounds(bb, {paddingTopLeft:[40, 40], paddingBottomRight:[Math.round(Math.min(520, Math.max(40, mw * 0.28))), 40], maxZoom:7.5, animate:false});
  }
}

function openUnplaced() {
  const cf = (x) => !S.client || x.c === S.client;
  const g = UNPLACED.filter(cf), c = UNPLACED_CONTRACTS.filter(cf);
  $('#drawer').innerHTML = `
    <div class="dr-head"><div class="dr-kicker">Reconciliation</div>
      <div class="l1"><h2 class="plain">Unplaced funding</h2><button class="dr-x" id="dclose" aria-label="Close">${I.x}</button></div>
      <div class="l2"><span class="pill notable">${money(g.reduce((a, x) => a + x.obl, 0) + c.reduce((a, x) => a + x.obl, 0))} not attributed to any district</span></div></div>
    <div class="dr-body">
      <div class="sec"><div class="sb" style="padding-top:15px">
        <div class="hint"><span class="hico">${I.info}</span><div>These awards are real and mapped to your clients, but their place of performance is statewide, undefined or unreported. Capiro will not split them across districts or assign them to one — they stay here and reconcile against source totals.</div></div>
      </div></div>
      ${sect('Awarded assistance', money(g.reduce((a, x) => a + x.obl, 0)), `
        <div class="tblwrap"><table class="htable"><thead><tr><th>Award</th><th>Client</th><th>Why unplaced</th><th class="n">Obligated</th></tr></thead><tbody>
        ${g.map(x => `<tr><td><span class="mono" style="font-size:11.5px">${esc(x.fain)}</span><div class="sub">${esc(x.sub)}</div></td>
          <td>${esc(CLIENT_BY_ID[x.c].short)}</td><td class="sub" style="max-width:190px">${esc(x.reason)}</td>
          <td class="n">${money(x.obl)}</td></tr>`).join('')}
        </tbody></table></div>`)}
      ${sect('Contract awards', money(c.reduce((a, x) => a + x.obl, 0)), `
        <div class="tblwrap"><table class="htable"><thead><tr><th>Award</th><th>Client</th><th>Why unplaced</th><th class="n">Obligated</th></tr></thead><tbody>
        ${c.map(x => `<tr><td><span class="mono" style="font-size:11.5px">${esc(x.piid)}</span></td>
          <td>${esc(CLIENT_BY_ID[x.c].short)}</td><td class="sub">${esc(x.reason)}</td>
          <td class="n">${money(x.obl)}</td></tr>`).join('')}
        </tbody></table></div>`)}
      <div class="sec"><div class="sb" style="padding-top:15px"><div class="hint info"><span class="hico">${I.info}</span><div>
        Statewide (<span class="mono">90</span>) and undefined (<span class="mono">ZZ</span>) codes never resolve to an at-large House member.
        At-large districts use code <span class="mono">00</span>, which is a real district.</div></div></div></div>
    </div>`;
  $('#drawer').classList.add('on'); $('#veil').classList.add('on');
  $('#dclose').onclick = closeDrawer;
  $('#drawer').querySelectorAll('.sec .sh').forEach(h => h.onclick = () => h.parentElement.classList.toggle('cl'));
}

/* ── page states ───────────────────────────────────── */
const flagOffHTML = () => `<div class="content scroll">
  ${pgHeadHTML()}
  <div class="guide"><div class="gico">${I.bolt}</div>
    <h4>District Nexus is not enabled for this organization</h4>
    <p>The <span class="mono">district_nexus_v2</span> flag is off for Hartwell &amp; Reid. The feature fails closed on both the web app and the API — the endpoints return 404 rather than an empty result, so nothing here can mislead you into thinking you have no district data.</p>
    <div class="row"><button class="btn" onclick="toast('An org admin enables this from Settings → Feature flags.')">Request access</button></div></div>
</div>`;
function loadingNexus() {
  const sk = (w, h, mt) => `<div class="skel" style="width:${w};height:${h}px;margin-top:${mt || 0}px"></div>`;
  $('#main').innerHTML = topbarHTML() + `<div class="content">
    ${pgHeadHTML()}
    <div class="kpis"><div class="kgrp">${[1,2,3,4,5].map(() => `<div class="kpi">${sk('72px', 9)}${sk('60px', 22, 8)}${sk('84px', 8, 6)}</div>`).join('')}</div>
      <div class="kgrp opp"><div class="kpi">${sk('110px', 9)}${sk('40px', 22, 8)}${sk('96px', 8, 6)}</div></div></div>
    <div class="fbar">${[1,2,3,4].map(() => `<div class="skel" style="width:128px;height:31px;border-radius:6px"></div>`).join('')}</div>
    <div class="split"><div class="mapcard"><div class="skel" style="position:absolute;inset:16px"></div></div>
      <div class="rail" style="padding:14px">${[1,2,3,4,5,6].map(() => `<div style="padding:11px 0;border-bottom:1px solid var(--border-1)">${sk('120px', 12)}${sk('100%', 6, 9)}${sk('180px', 8, 9)}</div>`).join('')}</div></div>
  </div>`;
  wireTopbar();
}
function errorNexus() {
  $('#main').innerHTML = topbarHTML() + `<div class="content scroll">${pgHeadHTML()}
    <div class="guide"><div class="gico" style="background:var(--critical-soft);color:var(--critical)">${I.warn}</div>
      <h4>District Nexus could not load</h4>
      <p>The aggregate request failed (<span class="mono">500 · district-nexus/map</span>). This is an error, not an empty result — Capiro will not show you a zeroed map that reads like “you have no district footprint.”</p>
      <div class="row"><button class="btn btn-accent" onclick="S.pageState='normal';render()">Retry</button></div></div></div>`;
  wireTopbar();
}
function emptyNexus() {
  $('#main').innerHTML = topbarHTML() + `<div class="content scroll">${pgHeadHTML()}
    <div class="guide"><div class="gico">${I.pin}</div>
      <h4>No client has a resolvable district yet</h4>
      <p>District Nexus builds on client facilities and confirmed award mappings. Add facility addresses to a client, or confirm a contractor / assistance-recipient mapping, and districts appear here within a day.</p>
      <div class="row"><button class="btn btn-accent" onclick="toast('Opens the client facilities editor.')">Add client facilities</button>
        <button class="btn" onclick="S.route='mappings';render()">Manage mappings</button></div></div></div>`;
  wireTopbar();
}

/* ══ ROUTE: CLIENT PROFILE — INTELLIGENCE TAB ══════════ */
function renderClient() {
  const c = CLIENT_BY_ID[S.profileClient];
  const list = DISTRICTS.map(d => Object.assign({}, d, scoreDistrict(d, [c.id])))
    .filter(d => d.rows.length || d.contracts.n || d.grants.n || d.targets.length)
    .sort((a, b) => b.score - a.score);
  const t = totals(list, c.id);
  const opp = OPPS.filter(o => o.client === c.id);
  const unG = UNPLACED.filter(x => x.c === c.id).reduce((a, x) => a + x.obl, 0);
  const reviewAssist = c.mappings.assistance_recipient === 'review';
  const noAssist = c.mappings.assistance_recipient === 'none';

  $('#main').innerHTML = `
  <div class="topbar">
    <div class="crumbs"><button data-nav3="1">Portfolio</button><span class="sep">/</span><b>${esc(c.name)}</b></div>
    <div class="rt"><div class="sel" id="cpick"><button class="dn-select"><span class="lab">Client</span><span class="val">${esc(c.short)}</span>${I.cv}</button></div></div>
  </div>
  <div class="content scroll">
    <div class="pg-head">
      <div style="display:flex;gap:15px;align-items:center">
        <div style="width:44px;height:44px;border-radius:var(--r-md);background:var(--bg-dark);color:#fff;display:grid;place-items:center;font-size:15px;font-weight:800">${esc(c.short[0])}</div>
        <div><h1 class="pg-title" style="font-size:26px">${esc(c.name)}</h1>
          <p class="pg-desc" style="margin-top:4px">${esc(c.sector)}</p></div>
      </div>
    </div>
    <div style="display:flex;gap:4px;border-bottom:1px solid var(--border-1);margin-top:-4px">
      ${['Overview','Engagements','Intelligence','Targets','Documents'].map(x => `<div style="font-size:13px;padding:9px 14px 10px;margin-bottom:-1px;border-bottom:2px solid ${x === 'Intelligence' ? 'var(--accent)' : 'transparent'};color:${x === 'Intelligence' ? 'var(--accent-ink)' : 'var(--ink-2)'};font-weight:${x === 'Intelligence' ? 600 : 500}">${x}</div>`).join('')}
    </div>
    <div style="display:grid;grid-template-columns:176px minmax(0,1fr);gap:24px;max-width:1080px">
      <div style="position:sticky;top:0;align-self:start;display:flex;flex-direction:column;gap:2px">
        <div class="src-label" style="padding:2px 10px 6px">On this page</div>
        ${['Signals','Federal footprint','District Nexus','Coalitions','Press'].map(x => `<div style="font-size:12.5px;padding:8px 10px;border-radius:var(--r-sm);${x === 'District Nexus' ? 'background:var(--bg-sunken);color:var(--ink-1);font-weight:600' : 'color:var(--ink-3)'}">${x}</div>`).join('')}
      </div>
      <section id="district-nexus" class="card">
        <div class="card-head"><h3>District Nexus</h3><span class="pill violet">v2</span>
          <button class="link-btn" style="margin-left:auto" id="fullmap">View full map ${I.ar}</button></div>
        <div class="card-body">
          <div style="display:flex;border:1px solid var(--border-1);border-radius:var(--r-md);overflow:hidden;margin-bottom:15px">
            ${[['Districts', t.districts, ''], ['Facilities', t.facilities, ''],
               ['Employees', num(t.employees), t.empUnknown ? t.empUnknown + ' not reported' : ''],
               ['Contracts', money(t.contracts), t.unmappedC ? money(t.unmappedC) + ' unplaced' : 'DoD prime only'],
               ['Grants', money(t.grants), unG ? money(unG) + ' unplaced' : money(t.outlays) + ' outlaid']]
              .map((x, i) => `<div style="flex:1;padding:10px 13px;${i ? 'border-left:1px solid var(--border-1)' : ''}">
                <div class="src-label" style="font-size:9.5px">${x[0]}</div>
                <div class="num" style="font-size:18px;font-weight:700;letter-spacing:-.02em;margin-top:2px">${x[1]}</div>
                <div style="font-size:10.5px;color:${String(x[2]).match(/unplaced|not reported/) ? 'var(--notable)' : 'var(--ink-3)'};margin-top:1px">${x[2] || '&nbsp;'}</div></div>`).join('')}
          </div>

          ${reviewAssist ? `<div class="hint notable" style="margin-bottom:14px"><span class="hico">${I.warn}</span><div>
            <b>Contract awards are linked; no assistance-recipient UEI is confirmed.</b>
            Two candidate UEIs matched by name only and are waiting for review — awarded grant dollars for this client are incomplete until one is confirmed.
            <div style="margin-top:8px"><button class="btn sm" id="goMap2">Review candidates</button></div></div></div>` : ''}
          ${noAssist ? `<div class="hint notable" style="margin-bottom:14px"><span class="hico">${I.warn}</span><div>
            <b>No assistance-recipient mapping.</b> Contract activity is linked, but awarded grants and cooperative agreements cannot be attributed to this client.
            <div style="margin-top:8px"><button class="btn sm" id="goMap2">Add mapping</button></div></div></div>` : ''}

          <div class="src-label" style="margin-bottom:7px">Top districts by nexus</div>
          <div style="border:1px solid var(--border-1);border-radius:var(--r-md);overflow:hidden">
            ${list.slice(0, 5).map((d, i) => { const b = bandOf(d.score); return `
              <div style="display:flex;align-items:center;gap:11px;padding:10px 13px;${i ? 'border-top:1px solid var(--border-1)' : ''}">
                <span class="mono" style="font-weight:700;font-size:13px;width:54px">${d.k}</span>
                <span style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:${b[2]};width:64px">${b[1]}</span>
                <div style="width:92px">${ebar(d)}</div>
                <div style="display:flex;gap:4px;flex-wrap:wrap;flex:1;min-width:0">${evidenceChips(d, 4)}</div>
                <button class="link-btn" data-go="/directory/districts/${d.k.slice(0,2)}/${d.k.slice(3)}">View district ${I.ar}</button>
              </div>`; }).join('')}
          </div>

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:15px">
            <div style="border:1px solid var(--border-1);border-radius:var(--r-md);padding:12px 14px">
              <div class="src-label" style="margin-bottom:7px">Awarded grant funding</div>
              <div style="font-size:12.5px;line-height:1.7"><b style="font-weight:700">${AWARDS.filter(a => a.c === c.id).length} active awards</b> · <span class="num">${money(t.grants)}</span> obligated<br>
                <span class="num">${money(t.outlays)}</span> outlaid to date${unG ? ` · <span style="color:var(--notable)"><span class="num">${money(unG)}</span> unplaced</span>` : ''}</div>
            </div>
            <div style="border:1px dashed var(--border-2);border-radius:var(--r-md);padding:12px 14px;background:var(--bg-surface-2)">
              <div class="src-label" style="margin-bottom:7px;color:var(--ink-4)">Opportunities · not awarded</div>
              <div style="font-size:12.5px;line-height:1.7"><b style="font-weight:700">${opp.length} potential match${opp.length === 1 ? '' : 'es'}</b>${opp.length ? ' · eligibility requires review' : ''}<br>
                <span style="color:var(--ink-3)">Never counted toward the funding totals above.</span></div>
            </div>
          </div>

          <div class="src-label" style="margin:17px 0 7px">Your representatives</div>
          <div style="border:1px solid var(--border-1);border-radius:var(--r-md);overflow:hidden">
            ${list.filter(d => d.rows.length).slice(0, 4).map((d, i) => { const sen = SENATORS[d.k.slice(0,2)] || []; return `
              <div style="padding:11px 13px;${i ? 'border-top:1px solid var(--border-1)' : ''}">
                <div style="font-size:12.5px;font-weight:600">${esc(d.rows[0].role)} <span class="mono" style="color:var(--ink-3);font-weight:500">${d.k}</span></div>
                <div style="display:flex;gap:18px;margin-top:5px;font-size:12px;flex-wrap:wrap;color:var(--ink-2)">
                  <span><span style="color:var(--ink-3)">House</span> ${esc(d.house[0])} (${d.house[1]})</span>
                  ${sen.map(s => `<span><span style="color:var(--ink-3)">Sen.</span> ${esc(s[0])} (${s[1]})</span>`).join('')}
                </div></div>`; }).join('')}
          </div>
          <div style="font-size:11.5px;color:var(--ink-3);margin-top:14px;line-height:1.6">
            Contract scope is DoD prime awards only. Awarded assistance is matched by confirmed UEI. Opportunity matches are not eligibility determinations.
            Boundary vintage: current, 119th Congress.</div>
        </div>
      </section>
    </div>
  </div>`;
  $('#fullmap').onclick = () => { S.route = 'nexus'; S.client = c.id; S.selected = null; S.filterKeys = null; render(); };
  const g2 = $('#goMap2'); if (g2) g2.onclick = () => { S.route = 'mappings'; render(); };
  $('#main').querySelectorAll('[data-go]').forEach(x => x.onclick = () => link(x.dataset.go));
  $('#main').querySelector('[data-nav3]').onclick = () => toast('Portfolio list is outside this prototype.');
  $('#cpick .dn-select').onclick = (e) => {
    e.stopPropagation();
    const p = popover($('#cpick'), `<div class="mh">Client</div>` +
      CLIENTS.map(x => `<div class="opt${x.id === c.id ? ' sel' : ''}" data-c="${x.id}">${esc(x.name)}</div>`).join(''), true);
    if (p) p.querySelectorAll('[data-c]').forEach(o => o.onclick = () => { S.profileClient = o.dataset.c; closePop(); render(); });
  };
}

/* ══ ROUTE: INTELLIGENCE MAPPINGS ══════════════════════ */
function renderMappings() {
  const confirmed = [];
  CLIENTS.forEach(c => c.ueis.forEach(u => confirmed.push(Object.assign({client:c}, u))));
  $('#main').innerHTML = `
  <div class="topbar"><div class="crumbs"><span>Settings</span><span class="sep">/</span><b>Intelligence mappings</b></div>
    <div class="rt"><button class="btn sm btn-accent" id="newMap">${I.plus} Map recipient</button></div></div>
  <div class="content scroll">
    <div class="pg-head"><div><h1 class="pg-title">Intelligence mappings</h1>
      <p class="pg-desc">Which external entities are this firm’s clients — the identity layer District Nexus depends on.</p></div></div>
    <div class="fbar">
      <div class="seg-toggle">${[['assistance_recipient','Assistance recipient'],['contracting','Contracting'],['lda','LDA'],['fec_employer','FEC employer']]
        .map(s => `<button class="${S.mapSource === s[0] ? 'on' : ''}" data-src="${s[0]}">${s[1]}</button>`).join('')}</div>
      <div class="rt"><span class="pill notable">${RESOLUTION_QUEUE.length} awaiting review</span></div>
    </div>
    ${S.mapSource !== 'assistance_recipient' ? `<div class="guide"><div class="gico">${I.grid}</div>
        <h4>${esc(S.mapSource.replace('_', ' '))} mappings</h4>
        <p>An existing source, unchanged by this work. The assistance-recipient tab is the new one.</p>
        <div class="row"><button class="btn" onclick="S.mapSource='assistance_recipient';render()">Back to assistance recipient</button></div></div>` : `
    <div class="card">
      <div class="card-head"><h3>Review queue</h3><span class="chip notable">name similarity only — never auto-confirmed</span></div>
      <div class="hint notable" style="border-radius:0;border-left:0;border-right:0;border-top:0"><span class="hico">${I.warn}</span><div>
        These candidates matched a client by <b>name similarity</b>. For the assistance rail that is a review candidate, never a confirmation —
        a parent UEI must not silently replace a subsidiary’s, and same-name entities in different states are routinely different legal entities.</div></div>
      <table class="htable">
        <thead><tr><th>Recipient</th><th>UEI</th><th>Parent</th><th>St</th><th class="n">Awards</th><th class="n">Obligated</th><th>Suggested client</th><th class="n">Score</th><th></th></tr></thead>
        <tbody>${RESOLUTION_QUEUE.map((r, i) => `<tr>
          <td><b style="font-weight:600">${esc(r.name)}</b></td>
          <td class="mono" style="font-size:11.5px">${esc(r.uei)}</td>
          <td class="sub" style="max-width:160px">${r.parent ? esc(r.parent) : '<span style="color:var(--ink-4)">—</span>'}</td>
          <td class="mono">${esc(r.state)}</td><td class="n">${r.awards}</td><td class="n">${money(r.obl)}</td>
          <td>${esc(CLIENT_BY_ID[r.client].name)}</td>
          <td class="n"><span class="chip ${r.conf >= .9 ? 'notable' : 'muted'}">${r.conf.toFixed(2)}</span></td>
          <td style="white-space:nowrap"><button class="btn sm" data-cfm="${i}">Confirm</button>
            <button class="btn sm btn-ghost" data-rej="${i}">Reject</button></td></tr>`).join('')}
        </tbody></table>
    </div>
    <div class="card">
      <div class="card-head"><h3>Confirmed assistance-recipient mappings</h3>
        <span class="sub">${confirmed.length} UEIs · ${new Set(confirmed.map(x => x.client.id)).size} clients</span></div>
      <table class="htable">
        <thead><tr><th>Client</th><th>Recipient name</th><th>UEI</th><th>St</th><th>Confidence</th><th>Method</th><th></th></tr></thead>
        <tbody>${confirmed.map(x => `<tr>
          <td><b style="font-weight:600">${esc(x.client.name)}</b></td><td>${esc(x.name)}</td>
          <td class="mono" style="font-size:11.5px">${esc(x.uei)}</td><td class="mono">${esc(x.state)}</td>
          <td><span class="chip success">1.00 confirmed</span></td><td class="sub">manual pin</td>
          <td><button class="link-btn" onclick="toast('Unmapping removes this UEI\\'s awards from every District Nexus total.')">Unmap</button></td></tr>`).join('')}
        </tbody></table>
    </div>
    <div class="card"><div class="card-body" style="font-size:12.5px;color:var(--ink-2);line-height:1.65">
      <b style="font-weight:700">Why the assistance rail is UEI-first.</b> The contract rail joins clients to awards by contractor-name equality — kept for compatibility, but it cannot
      distinguish subsidiaries and it silently misses renamed entities. Assistance identity is keyed on UEI: exact UEI match first, then a confirmed mapping, then a
      user-verified client-grant link. Multiple confirmed UEIs per client are supported and expected.</div></div>`}
  </div>`;
  $('#main').querySelectorAll('[data-src]').forEach(b => b.onclick = () => { S.mapSource = b.dataset.src; render(); });
  $('#newMap').onclick = () => toast('Opens the recipient picker: search federal_assistance_award by name or UEI.');
  $('#main').querySelectorAll('[data-cfm]').forEach(b => b.onclick = () => toast('Confirmed. Writes confidence 1.00 and re-runs District Nexus aggregation for this tenant.'));
  $('#main').querySelectorAll('[data-rej]').forEach(b => b.onclick = () => toast('Rejected. The candidate will not be re-suggested for this client.'));
}

/* ══ ROUTE: DATA EXPLORER ══════════════════════════════ */
function renderExplorer() {
  const rows = AWARDS.concat(UNPLACED.map(u => Object.assign({}, u, {d:null, typeL:'Project Grant', alnT:'—', outl:0, start:null, end:null})));
  $('#main').innerHTML = `
  <div class="topbar"><div class="crumbs"><span>Intelligence</span><span class="sep">/</span><b>Data Explorer</b></div></div>
  <div class="content scroll">
    <div class="pg-head"><div><h1 class="pg-title">Data Explorer</h1>
      <p class="pg-desc">Raw federal source records, exactly as ingested.</p></div></div>
    <div style="display:flex;gap:7px;flex-wrap:wrap">
      ${[['Federal Grant Awards', true, 'new source'], ['Grant Opportunities', false, 'was “Federal Grants”'],
         ['Federal Contract Awards (DoD)', false, 'was “Federal Awards”'], ['Lobbying Disclosures', false, ''], ['FEC', false, '']]
        .map(s => `<button class="btn${s[1] ? ' btn-accent' : ''}" ${s[1] ? '' : `onclick="toast('Existing Explorer source — unchanged by this work.')"`}>${s[0]}${s[2] ? `<span style="opacity:.62;font-size:11px;font-weight:400"> · ${s[2]}</span>` : ''}</button>`).join('')}
    </div>
    <div class="card">
      <div class="card-head"><h3>Federal Grant Awards</h3>
        <span class="chip muted">USAspending assistance · types 02 / 03 / 04 / 05</span>
        <span class="sub" style="margin-left:auto"><span class="num">${rows.length}</span> of <span class="num">1,284,331</span> records</span></div>
      <div style="padding:10px 16px;border-bottom:1px solid var(--border-1);display:flex;gap:7px;flex-wrap:wrap">
        ${['Recipient','UEI','Agency','Assistance Listing','State','District','Award type','Min obligation','End date']
          .map(f => `<span class="dn-select" style="padding:5px 9px;font-size:12px">${f} ${I.cv}</span>`).join('')}
      </div>
      <table class="htable">
        <thead><tr><th>FAIN</th><th>Recipient</th><th>Awarding agency</th><th>Assistance Listing</th><th>District</th><th class="n">Obligated</th><th class="n">Outlays</th><th>Period</th></tr></thead>
        <tbody>${rows.map(a => `<tr onclick="link('https://usaspending.gov/award/${esc(a.fain)}')" style="cursor:pointer">
          <td class="mono" style="font-size:11.5px">${esc(a.fain)}</td>
          <td>${esc(CLIENT_BY_ID[a.c].name)}<div class="sub mono">${esc((CLIENT_BY_ID[a.c].ueis[0] || {}).uei || '—')}</div></td>
          <td>${esc(a.agency)}<div class="sub">${esc(a.sub)}</div></td>
          <td class="mono">${esc(a.aln)}</td>
          <td class="mono">${a.d ? a.d : `<span class="chip notable" style="font-family:var(--font-sans)">${a.code === '90' ? 'statewide 90' : a.code === 'ZZ' ? 'ZZ' : 'unreported'}</span>`}</td>
          <td class="n">${money(a.obl)}</td><td class="n">${a.outl ? money(a.outl) : '—'}</td>
          <td class="sub" style="white-space:nowrap">${a.start ? fdate(a.start) + ' → ' + fdate(a.end) : '—'}</td></tr>`).join('')}
        </tbody></table>
    </div>
    <div class="card"><div class="card-body" style="font-size:12.5px;color:var(--ink-2);line-height:1.65">
      <b style="font-weight:700">Row click opens the USAspending award profile</b>, matching the existing behaviour of the contract and opportunity sources.
      A native detail drawer follows the 12-source drawer pattern once this source is stable.</div></div>
  </div>`;
}

/* ══ STATES INSPECTOR ══════════════════════════════════ */
const STATES = [
  ['normal','Normal','Full data, current boundaries'],
  ['loading','Loading','Skeletons while the aggregate resolves'],
  ['maperror','Map unavailable','WebGL or boundary artifact fails — table takes over, numbers unaffected'],
  ['error','Request failed','Explicit error, never a false “no data”'],
  ['empty','Empty tenant','No client has a resolvable district yet'],
  ['flagoff','Feature flag off','district_nexus_v2 disabled — fails closed']
];
function renderInspector() {
  $('#inspPn').innerHTML = `<h4>Force a state</h4>
    <div class="note">Every state below is a designed screen, not a bug. Honest partial states are the core requirement of this feature.</div>
    <div class="li">${STATES.map(s => `<div class="si${S.pageState === s[0] ? ' on' : ''}" data-s="${s[0]}"><span class="rd"></span>
      <div><div class="n">${s[1]}</div><div class="d">${s[2]}</div></div></div>`).join('')}</div>
    <div class="note" style="border-bottom:0">
      <div class="si${S.futureAvailable ? ' on' : ''}" data-fut="1" style="padding-left:0"><span class="rd" style="border-radius:3px"></span>
      <div><div class="n">Future boundary artifact exists</div><div class="d">Enables the “Enacted future” selector</div></div></div>
    </div>`;
  $('#inspPn').querySelectorAll('[data-s]').forEach(x => x.onclick = () => {
    S.pageState = x.dataset.s; S.route = 'nexus'; S.selected = null; closeDrawer(); render();
  });
  $('#inspPn').querySelector('[data-fut]').onclick = () => {
    S.futureAvailable = !S.futureAvailable; if (!S.futureAvailable) S.view = 'current'; render();
  };
}
$('#inspTg').onclick = (e) => { e.stopPropagation(); $('#insp').classList.toggle('on'); };
document.addEventListener('click', (e) => { if (!$('#insp').contains(e.target)) $('#insp').classList.remove('on'); });
$('#veil').onclick = () => selectDistrict(null);

/* ── render ────────────────────────────────────────── */
function render() {
  closePop(); killHover();
  renderNav(); renderInspector();
  if (S.route === 'nexus') {
    if (S.pageState === 'loading') return loadingNexus();
    if (S.pageState === 'error') return errorNexus();
    if (S.pageState === 'empty') return emptyNexus();
    renderNexus();
    const vb = $('#main').querySelectorAll('[data-view]');
    vb.forEach(x => x.onclick = () => { if (x.disabled) return; S.view = x.dataset.view; S.selected = null; S.filterKeys = null; closeDrawer(); render(); });
  } else {
    closeDrawer();
    if (S.route === 'client') renderClient();
    else if (S.route === 'mappings') renderMappings();
    else if (S.route === 'explorer') renderExplorer();
  }
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { if (S.selected) selectDistrict(null); closePop(); } });
render();
