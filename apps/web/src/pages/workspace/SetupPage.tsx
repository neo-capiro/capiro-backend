import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Spin } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { useApi } from '../../lib/use-api.js';
import { StepsRail } from './StepsRail.js';
import { Icon } from './kit.js';
import {
  useDraft,
  useUpdateDraft,
  useTemplatesFor,
  useAllTemplates,
  useProductDefaults,
  useSectionLibrary,
} from './api.js';
import {
  getProgramElementsList,
  getProgramElementDetail,
  getProgramElementProjects,
} from '../program-element/api.js';
import type { ProgramElementDetail, ProgramElementProject } from '../program-element/types.js';
import type { WsConfig, WsTemplate, WsLinkedProgramElement } from './types.js';

/** Debounce a fast-changing value (search-as-you-type → one query per pause). */
function useDebouncedValue<T>(value: T, ms = 250): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

/**
 * A controlled text field that stays responsive under autosave. The bug it
 * fixes: Setup inputs were bound straight to the server-round-tripped config and
 * committed on every keystroke, so an in-flight autosave echo (qc.setQueryData)
 * clobbered the field mid-typing and dropped characters. This keeps a LOCAL
 * working copy (instant), commits debounced + on blur, and only re-adopts the
 * incoming value when the field isn't focused — so the server echo can't reset
 * the cursor while the user is typing.
 */
function AutosaveField({
  value,
  onCommit,
  multiline = false,
  debounceMs = 450,
  className,
  style,
  placeholder,
  rows,
  type,
}: {
  value: string;
  onCommit: (v: string) => void;
  multiline?: boolean;
  debounceMs?: number;
  className?: string;
  style?: React.CSSProperties;
  placeholder?: string;
  rows?: number;
  type?: string;
}) {
  const [local, setLocal] = useState(value);
  const focused = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<string | null>(null);
  const commitRef = useRef(onCommit);
  commitRef.current = onCommit;

  // Adopt external changes (restore, another control's save) only when idle.
  useEffect(() => {
    if (!focused.current) setLocal(value);
  }, [value]);
  // On unmount, FLUSH any pending debounce (programmatic navigation, a parent
  // re-rendering into a Spin guard, or a conditional unmount won't fire a blur),
  // so the last typed-but-not-yet-saved keystrokes aren't lost.
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      if (pending.current !== null) commitRef.current(pending.current);
    },
    [],
  );

  const schedule = (v: string) => {
    pending.current = v;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      pending.current = null;
      commitRef.current(v);
    }, debounceMs);
  };
  const onChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    setLocal(e.target.value);
    schedule(e.target.value);
  };
  const onBlur = () => {
    focused.current = false;
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    pending.current = null;
    if (local !== value) commitRef.current(local);
  };
  const onFocus = () => {
    focused.current = true;
  };

  if (multiline) {
    return (
      <textarea
        value={local}
        onChange={onChange}
        onFocus={onFocus}
        onBlur={onBlur}
        className={className}
        style={style}
        placeholder={placeholder}
        rows={rows}
      />
    );
  }
  return (
    <input
      value={local}
      onChange={onChange}
      onFocus={onFocus}
      onBlur={onBlur}
      className={className}
      style={style}
      placeholder={placeholder}
      type={type}
    />
  );
}

/**
 * Setup — the cascade qualifier + secondary qualifiers, ported near-verbatim from
 * the locked prototype (asset_13 `SetupForm` + helpers). Renders inside the real
 * app shell (.ws-root) using the prototype's scoped DS classes (workspace-ds.css).
 *
 * All config edits autosave via useUpdateDraft(draftId).mutate({ config }) — the
 * engine merges the partial. Cascade reseeds are computed client-side (the WSC
 * mirror below) so each reseed lands in ONE atomic patch (never an invalid combo).
 */

// ── Client-side cascade mirror (asset_04 WSC / CASCADE / PRODUCT_META) ─────────
// Used ONLY to compute atomic reseed patches synchronously on industry/product
// change. The authoritative copy lives server-side (apps/workspace cascade.config).
interface CascadeIndustry {
  industry: string;
  products: { name: string; pathways: string[] }[];
  pathways: Record<string, string[]>;
}
const CASCADE: CascadeIndustry[] = [
  {
    industry: 'Defense & Aerospace',
    products: [
      { name: 'NDAA Authorization Request', pathways: ['NDAA Authorization'] },
      {
        name: 'Meeting Brief & Advocacy',
        pathways: ['NDAA Authorization', 'Defense Appropriations'],
      },
      { name: 'Appropriations Justification', pathways: ['Defense Appropriations'] },
      { name: 'CDS / Earmark Application', pathways: ['Defense Appropriations'] },
    ],
    pathways: {
      'NDAA Authorization': ['HASC', 'SASC'],
      'Defense Appropriations': ['HAC-D', 'SAC-D'],
    },
  },
  {
    industry: 'Health & Pharma',
    products: [
      { name: 'Appropriations Justification', pathways: ['Labor-HHS Appropriations'] },
      {
        name: 'Meeting Brief & Advocacy',
        pathways: ['Labor-HHS Appropriations', 'HELP Authorization'],
      },
      { name: 'Authorization Bill Language', pathways: ['HELP Authorization'] },
    ],
    pathways: { 'Labor-HHS Appropriations': ['L-HHS'], 'HELP Authorization': ['HELP'] },
  },
  {
    industry: 'Energy & Resources',
    products: [
      { name: 'Appropriations Justification', pathways: ['Energy & Water Appropriations'] },
      { name: 'Authorization Bill Language', pathways: ['ENR Authorization'] },
    ],
    pathways: { 'Energy & Water Appropriations': ['E&W'], 'ENR Authorization': ['ENR'] },
  },
  {
    industry: 'Agriculture',
    products: [
      { name: 'Appropriations Justification', pathways: ['Agriculture Appropriations'] },
      { name: 'Authorization Bill Language', pathways: ['Farm Bill Authorization'] },
    ],
    pathways: {
      'Agriculture Appropriations': ['HAC-Ag'],
      'Farm Bill Authorization': ['Senate Ag'],
    },
  },
  {
    industry: 'Transportation',
    products: [
      { name: 'Appropriations Justification', pathways: ['T-HUD Appropriations'] },
      { name: 'CDS / Earmark Application', pathways: ['T-HUD Appropriations'] },
    ],
    pathways: { 'T-HUD Appropriations': ['T-HUD', 'T&I'] },
  },
  {
    industry: 'Homeland Security',
    products: [
      { name: 'Appropriations Justification', pathways: ['Homeland Security Appropriations'] },
      { name: 'Authorization Bill Language', pathways: ['Homeland Security Appropriations'] },
    ],
    pathways: { 'Homeland Security Appropriations': ['HAC-HS', 'SAC-HS'] },
  },
  {
    industry: 'Environment',
    products: [
      { name: 'Appropriations Justification', pathways: ['Interior & Environment Appropriations'] },
      { name: 'CDS / Earmark Application', pathways: ['Interior & Environment Appropriations'] },
    ],
    pathways: { 'Interior & Environment Appropriations': ['Int/Env', 'EPW'] },
  },
  {
    industry: 'Commerce & Tech',
    products: [
      { name: 'Appropriations Justification', pathways: ['CJS Appropriations'] },
      { name: 'Report Language Request', pathways: ['CJS Appropriations'] },
    ],
    pathways: { 'CJS Appropriations': ['CJS', 'Commerce', 'Science'] },
  },
];
const UNIVERSAL_PRODUCTS = ['Member letter', 'Written testimony', 'One-pager', 'Strategy memo'];
const ALL_PRODUCTS = (() => {
  const set: string[] = [];
  CASCADE.forEach((c) =>
    c.products.forEach((p) => (set.includes(p.name) ? null : set.push(p.name))),
  );
  UNIVERSAL_PRODUCTS.forEach((p) => (set.includes(p) ? null : set.push(p)));
  return set;
})();

interface ProductMetaRow {
  icon: string;
  personalize: boolean;
  office: boolean;
  cover: boolean;
  desc: string;
}
const PRODUCT_META: Record<string, ProductMetaRow> = {
  'White paper': {
    icon: 'FileText',
    personalize: false,
    office: true,
    cover: false,
    desc: 'Narrative program paper supporting authorization, appropriations, or policy asks.',
  },
  'Appropriations Justification': {
    icon: 'Coins',
    personalize: false,
    office: true,
    cover: true,
    desc: "Detail a program's funding need and justification.",
  },
  'NDAA Authorization Request': {
    icon: 'TrendingUp',
    personalize: false,
    office: true,
    cover: true,
    desc: 'Request program authorization or a budget adjustment.',
  },
  'Meeting Brief & Advocacy': {
    icon: 'Users',
    personalize: false,
    office: true,
    cover: false,
    desc: 'Leave-behind brief for a member or staff meeting.',
  },
  'CDS / Earmark Application': {
    icon: 'Landmark',
    personalize: true,
    office: true,
    cover: true,
    desc: 'Community project funding application.',
  },
  'Authorization Bill Language': {
    icon: 'Scale',
    personalize: false,
    office: false,
    cover: false,
    desc: 'Amendatory statutory / authorizing text.',
  },
  'Report Language Request': {
    icon: 'FileSignature',
    personalize: false,
    office: false,
    cover: false,
    desc: 'Directive or encouraging committee report language.',
  },
  'Member letter': {
    icon: 'Mail',
    personalize: true,
    office: true,
    cover: false,
    desc: 'Cosponsor request, support letter, or consolidated sign-on letter to a Member.',
  },
  'Strategy memo': {
    icon: 'ClipboardList',
    personalize: false,
    office: false,
    cover: false,
    desc: 'Internal brief covering situation analysis and strategic recommendation.',
  },
  'Written testimony': {
    icon: 'Mic',
    personalize: false,
    office: false,
    cover: false,
    desc: 'Statement for the record before a committee or agency.',
  },
  'One-pager': {
    icon: 'File',
    personalize: false,
    office: true,
    cover: false,
    desc: 'Meeting leave-behind or fact sheet summarizing the program and ask.',
  },
};
const SUGGESTED_SECTIONS: Record<string, string[]> = {
  'NDAA Authorization Request': [
    'Problem statement',
    'Solution',
    'Current status',
    'Funding history & request',
    'National security impact',
    'Economic & district impact',
    'The ask',
  ],
  'Appropriations Justification': [
    'Executive summary',
    'Account & program line',
    'Program description',
    'Funding history',
    'Justification & impact',
    'Performance & outcomes',
    'The ask',
  ],
  'CDS / Earmark Application': [
    'Requesting entity & recipient information',
    'Project title',
    'Project description',
    'Requested amount & total cost',
    'Federal nexus statement',
    'Evidence of community support',
    'Financial disclosure certification',
    'Outcomes & metrics',
  ],
  'Authorization Bill Language': [
    'Short title',
    'Findings & purpose',
    'Definitions',
    'Main operative provision',
    'Exceptions & special rules',
    'Conforming & transitional provisions',
    'Authorization of appropriations',
    'Effective date',
  ],
  'Report Language Request': [
    'Requesting entity & contact',
    'Bill, account & subcommittee',
    'Background & problem',
    'Proposed report language',
    'Justification',
    'Relationship to existing law & PBR',
  ],
  'Meeting Brief & Advocacy': [
    'Meeting logistics',
    'Member profile',
    'Background',
    'Objectives & the ask',
    'Talking points',
    'Anticipated questions & responses',
    'Leave-behind summary',
    'Follow-up plan',
  ],
  'Member letter': ['Opening', 'Program description', 'Request', 'Closing'],
  'Written testimony': [
    'Disclosure & witness intro',
    'Opening statement',
    'Background',
    'Position',
    'Recommendations',
    'Closing',
  ],
  'One-pager': [
    'Header & title',
    'Background',
    'Key facts & data',
    'Our position & the ask',
    'Contact information',
  ],
  'Strategy memo': ['Situation', 'Background', 'Analysis', 'Recommendation', 'Next steps'],
  'White paper': [
    'Problem statement',
    'Solution',
    'Current status',
    'Funding history & request',
    'National security impact',
    'Economic & district impact',
    'The ask',
  ],
};
const SUGGESTED_PAGES: Record<string, number> = {
  'White paper': 2,
  'Appropriations Justification': 2,
  'NDAA Authorization Request': 2,
  'Meeting Brief & Advocacy': 1,
  'Strategy memo': 2,
  'Member letter': 1,
  'Written testimony': 5,
  'One-pager': 1,
  'CDS / Earmark Application': 2,
  'Authorization Bill Language': 3,
  'Report Language Request': 1,
};
const WSC = {
  industries: (): string[] => CASCADE.map((c) => c.industry),
  _ind: (industry: string | null) => CASCADE.find((c) => c.industry === industry),
  productsFor(industry: string | null): string[] {
    const ind = this._ind(industry);
    if (!ind) return [];
    return [...new Set([...ind.products.map((p) => p.name), ...UNIVERSAL_PRODUCTS])];
  },
  allProducts: (): string[] => ALL_PRODUCTS,
  pathwaysFor(industry: string | null, product: string | null): string[] {
    const ind = this._ind(industry);
    if (!ind) return [];
    if (product && UNIVERSAL_PRODUCTS.includes(product)) return Object.keys(ind.pathways);
    const p = ind.products.find((x) => x.name === product);
    return p ? p.pathways : Object.keys(ind.pathways);
  },
  committeesFor(industry: string | null, pathways: string[]): string[] {
    const ind = this._ind(industry);
    if (!ind) return [];
    const out: string[] = [];
    (pathways || []).forEach((pw) =>
      (ind.pathways[pw] || []).forEach((c) => (out.includes(c) ? null : out.push(c))),
    );
    return out;
  },
  meta: (product: string | null): ProductMetaRow =>
    (product && PRODUCT_META[product]) || {
      icon: 'FileText',
      personalize: false,
      office: true,
      cover: true,
      desc: '',
    },
};
const suggestedSections = (product: string | null): string[] =>
  ((product && SUGGESTED_SECTIONS[product]) || ['Summary', 'Background', 'The ask']).slice();
const suggestedPages = (product: string | null): number =>
  (product && SUGGESTED_PAGES[product]) || 2;

// Patch shape carried into update.mutate({ config }). Partial<WsConfig> + ask.
type ConfigPatch = Partial<WsConfig> & { ask?: { amount?: string; pb?: string; delta?: string } };

const SECTION_LABEL: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: '0.07em',
  color: 'var(--ink-3)',
  marginBottom: 8,
};

// ── Page ──────────────────────────────────────────────────────────────────────
export function SetupPage() {
  const { draftId } = useParams();
  const { data: draft, isLoading } = useDraft(draftId ?? null);
  const update = useUpdateDraft(draftId ?? '');

  if (isLoading || !draft) {
    return (
      <div className="ws-shell">
        <StepsRail active="setup" draftId={draftId} />
        <div className="ws-stage" style={{ textAlign: 'center', padding: 60 }}>
          <Spin />
        </div>
      </div>
    );
  }

  const cfg = draft.config;
  const patch = (p: ConfigPatch) => update.mutate({ config: p });
  // Draft-level field (not config) — the top "Select client" picker persists the
  // linked client here. '' clears it. When the client CHANGES, also reset any
  // client-scoped config (clientPersons) so stale contacts from the old client
  // don't linger in the persisted draft.
  const setClient = (name: string | null) => {
    const next = name ?? '';
    if (next === (draft.client ?? '')) return;
    update.mutate({ client: next, config: { clientPersons: [] } });
  };

  return (
    <div className="ws-shell">
      <StepsRail active="setup" draftId={draftId} product={draft.product} />
      <div className="ws-stage" style={{ padding: 0 }}>
        <SetupForm
          cfg={cfg}
          draftId={draftId!}
          client={draft.client}
          update={patch}
          setClient={setClient}
        />
      </div>
    </div>
  );
}

// ── SetupForm (asset_13) ───────────────────────────────────────────────────────
function SetupForm({
  cfg,
  draftId,
  client,
  update,
  setClient,
}: {
  cfg: WsConfig;
  draftId: string;
  client: string | null;
  update: (p: ConfigPatch) => void;
  setClient: (name: string | null) => void;
}) {
  const navigate = useNavigate();
  const [showAll, setShowAll] = useState(false);

  const pickIndustry = (industry: string) => {
    const products = WSC.productsFor(industry);
    const product =
      cfg.product && products.includes(cfg.product) ? cfg.product : (products[0] ?? null);
    const pathways = WSC.pathwaysFor(industry, product).slice(0, 1);
    update({ industry, product, pathways, committees: WSC.committeesFor(industry, pathways) });
  };
  const pickProduct = (product: string) => {
    const m = WSC.meta(product);
    const pathways = WSC.pathwaysFor(cfg.industry, product).slice(0, 1);
    update({
      product,
      pathways,
      committees: WSC.committeesFor(cfg.industry, pathways),
      personalize: m.personalize,
      // Office/client personalization always defaults to "No" — opt-in per draft
      // (do NOT re-derive from the product meta on product switch).
      officeAssociated: false,
      coverLetter: m.cover,
      sections: suggestedSections(product),
      pages: suggestedPages(product),
    });
  };
  const togglePathway = (pw: string) => {
    const pathways = cfg.pathways.includes(pw)
      ? cfg.pathways.filter((x) => x !== pw)
      : [...cfg.pathways, pw];
    update({ pathways, committees: WSC.committeesFor(cfg.industry, pathways) });
  };
  const toggleCommittee = (c: string) =>
    update({
      committees: cfg.committees.includes(c)
        ? cfg.committees.filter((x) => x !== c)
        : [...cfg.committees, c],
    });

  const presets = WSC.productsFor(cfg.industry);
  const extra = WSC.allProducts().filter((p) => !presets.includes(p));
  const pathways = WSC.pathwaysFor(cfg.industry, cfg.product);
  const committees = WSC.committeesFor(cfg.industry, cfg.pathways);
  const m = WSC.meta(cfg.product);
  // A client is REQUIRED before building context (it scopes every Context
  // Builder source). Gate the Continue button on it.
  const hasClient = !!(client && client.trim());

  return (
    <div style={{ maxWidth: 840, margin: '0 auto', padding: '26px 30px 40px' }}>
      <h1
        style={{
          fontFamily: 'var(--font-serif)',
          fontWeight: 500,
          fontSize: 26,
          letterSpacing: '-0.01em',
          margin: '0 0 4px',
        }}
      >
        Set up the work product
      </h1>
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: 10,
          padding: '11px 14px',
          background: 'var(--accent-soft)',
          border: '1px solid var(--accent-glow, rgba(59,91,219,0.2))',
          borderRadius: 9,
          marginBottom: 20,
          maxWidth: 620,
        }}
      >
        <Icon
          name="Sparkles"
          size={15}
          style={{ color: 'var(--accent)', flexShrink: 0, marginTop: 1 }}
        />
        <span style={{ fontSize: 12.5, color: 'var(--accent-ink)', lineHeight: 1.5 }}>
          The more context you provide here, the better Meri's draft will be. You can always adjust
          in the editor.
        </span>
      </div>

      <ClientSelectCard client={client} setClient={setClient} />

      <QCard title="Work product setup">
        {/* Step 1: Industry */}
        <div>
          <div style={SECTION_LABEL}>Industry</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
            {WSC.industries().map((ind) => (
              <Chip key={ind} on={cfg.industry === ind} onClick={() => pickIndustry(ind)}>
                {ind}
              </Chip>
            ))}
          </div>
        </div>
        {/* Step 2: Work product */}
        {cfg.industry && (
          <div style={{ paddingTop: 14, borderTop: '1px solid var(--border-1)', marginTop: 14 }}>
            <div style={SECTION_LABEL}>Work product</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {presets.map((p) => {
                const pm = WSC.meta(p);
                return (
                  <Chip
                    key={p}
                    icon={pm.icon}
                    on={cfg.product === p}
                    onClick={() => pickProduct(p)}
                  >
                    {p}
                  </Chip>
                );
              })}
              <button
                onClick={() => setShowAll((s) => !s)}
                className="btn sm btn-ghost"
                style={{ color: 'var(--accent)' }}
              >
                <Icon name={showAll ? 'ChevronUp' : 'Plus'} size={13} />
                {showAll ? 'Less' : 'Other work product'}
              </button>
            </div>
            {showAll && (
              <div
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: 8,
                  marginTop: 9,
                  paddingTop: 11,
                  borderTop: '1px dashed var(--border-1)',
                }}
              >
                {extra.map((p) => {
                  const pm = WSC.meta(p);
                  return (
                    <Chip
                      key={p}
                      icon={pm.icon}
                      on={cfg.product === p}
                      onClick={() => pickProduct(p)}
                    >
                      {p}
                    </Chip>
                  );
                })}
              </div>
            )}
            {m.desc && (
              <div
                style={{
                  fontSize: 11.5,
                  color: 'var(--ink-3)',
                  marginTop: 11,
                  fontStyle: 'italic',
                }}
              >
                {m.desc}
              </div>
            )}
          </div>
        )}
        {/* Step 3: Legislative pathway */}
        {cfg.product && (
          <div style={{ paddingTop: 14, borderTop: '1px solid var(--border-1)', marginTop: 14 }}>
            <div style={SECTION_LABEL}>Legislative pathway</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
              {pathways.map((pw) => (
                <Chip key={pw} on={cfg.pathways.includes(pw)} onClick={() => togglePathway(pw)}>
                  {pw}
                </Chip>
              ))}
            </div>
          </div>
        )}
        {/* Step 4: Committee / subcommittee */}
        {cfg.pathways.length > 0 && (
          <div style={{ paddingTop: 14, borderTop: '1px solid var(--border-1)', marginTop: 14 }}>
            <div style={SECTION_LABEL}>Committee / subcommittee</div>
            {committees.length ? (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
                {committees.map((c) => (
                  <Chip key={c} on={cfg.committees.includes(c)} onClick={() => toggleCommittee(c)}>
                    {c}
                  </Chip>
                ))}
              </div>
            ) : (
              <div style={{ fontSize: 12, color: 'var(--ink-3)' }}>
                Select a pathway above to see committees.
              </div>
            )}
          </div>
        )}
      </QCard>

      {/* Templates: Meri suggests a starting structure; user picks or builds their own */}
      <TemplatesPicker cfg={cfg} update={update} />

      {/* Personalization — above Links & Data so offices/contacts are known before linking */}
      <QCard title="Personalization">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 15 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 14,
              flexWrap: 'wrap',
            }}
          >
            <div style={{ fontSize: 12.5, fontWeight: 600 }}>
              Does this work product require personalization for an office, client, or other
              contact?
            </div>
            <Seg
              options={[
                ['std', 'Standardized'],
                ['pers', 'Personalized'],
              ]}
              value={cfg.personalize ? 'pers' : 'std'}
              onChange={(v) => update({ personalize: v === 'pers' })}
            />
          </div>
          {cfg.personalize && (
            <>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 14,
                  flexWrap: 'wrap',
                  paddingTop: 14,
                  borderTop: '1px solid var(--border-1)',
                }}
              >
                <div style={{ fontSize: 12.5, fontWeight: 600 }}>Tied to a specific office?</div>
                <Seg
                  options={[
                    ['no', 'No'],
                    ['yes', 'Yes'],
                  ]}
                  value={cfg.officeAssociated ? 'yes' : 'no'}
                  onChange={(v) => update({ officeAssociated: v === 'yes' })}
                />
              </div>
              {cfg.officeAssociated && <OfficePicker cfg={cfg} client={client} update={update} />}
              {/* "Tied to a specific client contact?" removed — the client is now
                  chosen at the top of Setup (Select client), so this sub-question
                  is redundant. */}
            </>
          )}
        </div>
      </QCard>

      <LinkedDataCard cfg={cfg} update={update} />

      {/* Document options */}
      <QCard title="Document options">
        <OptRow
          label="Length target"
          first
          hint={
            'Suggested ' +
            suggestedPages(cfg.product) +
            ' page' +
            (suggestedPages(cfg.product) > 1 ? 's' : '') +
            ' for a ' +
            cfg.product +
            '. Set any length.'
          }
          control={
            <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
              <button
                className="btn sm btn-ghost"
                onClick={() => update({ pages: Math.max(1, (cfg.pages || 1) - 1) })}
                style={{ padding: '6px 9px' }}
              >
                <Icon name="Minus" size={13} />
              </button>
              <input
                type="number"
                min="1"
                value={cfg.pages}
                onChange={(e) =>
                  update({ pages: Math.max(1, parseInt(e.target.value || '1', 10)) })
                }
                className="field num"
                style={{
                  width: 52,
                  textAlign: 'center',
                  padding: '7px 6px',
                  fontSize: 13,
                  fontFamily: 'var(--font-mono)',
                  background: 'var(--bg-surface)',
                }}
              />
              <button
                className="btn sm btn-ghost"
                onClick={() => update({ pages: (cfg.pages || 1) + 1 })}
                style={{ padding: '6px 9px' }}
              >
                <Icon name="Plus" size={13} />
              </button>
            </div>
          }
        />
        <OptRow
          label="Writing tone"
          control={
            <Seg
              options={[
                ['Formal', 'Formal'],
                ['Plain', 'Plain'],
                ['Persuasive', 'Persuasive'],
              ]}
              value={cfg.tone}
              onChange={(v) => update({ tone: v })}
            />
          }
        />
        <div
          style={{
            padding: '10px 13px',
            background: 'var(--accent-soft)',
            border: '1px solid var(--accent-glow, rgba(59,91,219,0.2))',
            borderRadius: 8,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
            <Icon name="Sparkles" size={13} style={{ color: 'var(--accent)' }} />
            <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--accent-ink)' }}>
              Key focus or goal for Meri{' '}
              <span style={{ fontWeight: 400, fontSize: 11 }}>(optional)</span>
            </span>
          </div>
          <AutosaveField
            multiline
            value={cfg.toneContext || ''}
            onCommit={(v) => update({ toneContext: v })}
            placeholder="e.g. Emphasize ROI and job creation. Focus on bipartisan appeal and economic impact."
            rows={2}
            className="field"
            style={{
              width: '100%',
              padding: '8px 12px',
              fontSize: 12.5,
              fontFamily: 'var(--font-sans)',
              background: 'rgba(255,255,255,0.7)',
              resize: 'vertical',
              lineHeight: 1.5,
              boxSizing: 'border-box',
              border: '1px solid var(--accent-glow, rgba(59,91,219,0.25))',
            }}
          />
        </div>
        <OptRow
          label="Cover letter"
          hint="Add a firm-letterhead transmittal letter to this packet — draft it in the editor."
          control={
            <Seg
              options={[
                ['no', 'No'],
                ['yes', 'Yes'],
              ]}
              value={cfg.coverLetter ? 'yes' : 'no'}
              onChange={(v) => update({ coverLetter: v === 'yes' })}
            />
          }
        />
      </QCard>

      <LetterheadCard cfg={cfg} update={update} />

      <div
        style={{
          display: 'flex',
          justifyContent: 'flex-end',
          alignItems: 'center',
          gap: 12,
          marginTop: 20,
        }}
      >
        {!hasClient && (
          <span style={{ fontSize: 12, color: 'var(--ink-3)' }}>Select a client to continue</span>
        )}
        <button
          className="btn btn-accent"
          disabled={!hasClient}
          onClick={() => hasClient && navigate(`/workspace/context/${draftId}`)}
          style={!hasClient ? { opacity: 0.5, cursor: 'not-allowed' } : undefined}
        >
          Continue · Build context
          <Icon name="ArrowRight" size={14} />
        </button>
      </div>
    </div>
  );
}

// ── small primitives (asset_13) ────────────────────────────────────────────────
function Chip({
  on,
  onClick,
  children,
  icon,
  disabled,
  style,
}: {
  on?: boolean;
  onClick?: () => void;
  children: React.ReactNode;
  icon?: string;
  disabled?: boolean;
  style?: React.CSSProperties;
}) {
  return (
    <button
      onClick={disabled ? undefined : onClick}
      className="btn sm"
      style={{
        borderColor: on ? 'var(--accent)' : 'var(--border-1)',
        background: on ? 'var(--accent-soft)' : 'var(--bg-surface)',
        color: on ? 'var(--accent-ink)' : 'var(--ink-2)',
        opacity: disabled ? 0.45 : 1,
        cursor: disabled ? 'default' : 'pointer',
        ...style,
      }}
    >
      {icon ? <Icon name={icon} size={13} /> : on ? <Icon name="Check" size={12} /> : null}
      {children}
    </button>
  );
}

function Seg({
  options,
  value,
  onChange,
}: {
  options: [string, string][];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div
      style={{
        display: 'inline-flex',
        border: '1px solid var(--border-1)',
        borderRadius: 8,
        overflow: 'hidden',
        background: 'var(--bg-surface)',
      }}
    >
      {options.map(([v, l], i) => (
        <button
          key={v}
          onClick={() => onChange(v)}
          style={{
            padding: '7px 15px',
            border: 'none',
            borderLeft: i ? '1px solid var(--border-1)' : 'none',
            background: value === v ? 'var(--accent)' : 'transparent',
            color: value === v ? '#fff' : 'var(--ink-2)',
            fontSize: 12.5,
            fontWeight: 600,
            cursor: 'pointer',
            fontFamily: 'var(--font-sans)',
          }}
        >
          {l}
        </button>
      ))}
    </div>
  );
}

function QCard({
  n,
  title,
  hint,
  children,
  accent,
}: {
  n?: number | string;
  title: string;
  hint?: string;
  children: React.ReactNode;
  accent?: boolean;
}) {
  return (
    <div
      className="card"
      style={{
        padding: 18,
        marginBottom: 14,
        borderColor: accent ? 'var(--accent)' : 'var(--border-1)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: hint ? 6 : 12 }}>
        {n != null && (
          <span
            className="num"
            style={{
              width: 22,
              height: 22,
              borderRadius: '50%',
              flex: 'none',
              display: 'grid',
              placeItems: 'center',
              fontSize: 11,
              fontWeight: 700,
              background: 'var(--accent-soft)',
              color: 'var(--accent)',
            }}
          >
            {n}
          </span>
        )}
        <div style={{ fontSize: 13, fontWeight: 700, whiteSpace: 'nowrap' }}>{title}</div>
      </div>
      {hint && (
        <p
          style={{
            fontSize: 12,
            color: 'var(--ink-3)',
            margin: '0 0 12px',
            paddingLeft: n != null ? 32 : 0,
            lineHeight: 1.45,
          }}
        >
          {hint}
        </p>
      )}
      <div style={{ paddingLeft: n != null ? 32 : 0 }}>{children}</div>
    </div>
  );
}

function OptRow({
  label,
  hint,
  control,
  first,
}: {
  label: string;
  hint?: string;
  control: React.ReactNode;
  first?: boolean;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 14,
        flexWrap: 'wrap',
        padding: '13px 0',
        borderTop: first ? 'none' : '1px solid var(--border-1)',
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 12.5, fontWeight: 600 }}>{label}</div>
        {hint && <div style={{ fontSize: 11.5, color: 'var(--ink-3)', marginTop: 2 }}>{hint}</div>}
      </div>
      {control}
    </div>
  );
}

// ── Document thumbnail — rendered page at scale (asset_13) ──────────────────────
function DocThumbnail({ tpl, scale }: { tpl: WsTemplate; scale?: number }) {
  const sc = scale || 0.38;
  const W = 420,
    H = 560;
  const accent = tpl.accentColor || '#1B2D5B';
  const isSerif = tpl.style === 'serif-formal';
  const fontFamily = tpl.fontFamily || undefined;
  const L = ({ w, h, mt, bg }: { w?: number | string; h?: number; mt?: number; bg?: string }) => (
    <div
      style={{
        height: h || 4,
        width: w || '100%',
        borderRadius: 2,
        background: bg || '#d1d5db',
        marginTop: mt || 0,
        flexShrink: 0,
      }}
    />
  );
  const pageContent = isSerif ? (
    <div
      style={{
        width: W,
        height: H,
        background: '#fff',
        fontFamily,
        padding: '0 0 24px',
        boxSizing: 'border-box',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div style={{ height: 5, background: accent, flexShrink: 0 }} />
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '10px 28px 9px',
          borderBottom: '1px solid ' + accent,
          flexShrink: 0,
        }}
      >
        <div
          style={{ width: 20, height: 20, borderRadius: 3, background: accent, flexShrink: 0 }}
        />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2.5 }}>
          <div style={{ width: 90, height: 5, borderRadius: 1.5, background: accent }} />
          <div style={{ width: 65, height: 3, borderRadius: 1.5, background: '#9ca3af' }} />
        </div>
      </div>
      <div style={{ padding: '14px 28px 0', flexShrink: 0 }}>
        <div
          style={{ width: '80%', height: 11, borderRadius: 2, background: accent, marginBottom: 5 }}
        />
        <div
          style={{
            width: '52%',
            height: 6,
            borderRadius: 2,
            background: '#6b7280',
            marginBottom: 3,
          }}
        />
        <div
          style={{
            width: '38%',
            height: 3.5,
            borderRadius: 1.5,
            background: '#d1d5db',
            marginBottom: 16,
          }}
        />
      </div>
      <div
        style={{
          flex: 1,
          padding: '0 28px',
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          overflow: 'hidden',
        }}
      >
        <div>
          <div
            style={{
              fontSize: 6.5,
              fontWeight: 700,
              letterSpacing: '0.12em',
              textTransform: 'uppercase',
              color: accent,
              marginBottom: 5,
            }}
          >
            Executive Summary
          </div>
          <L />
          <L w="91%" mt={3} />
          <L w="97%" mt={3} />
          <L w="68%" mt={3} />
        </div>
        <div>
          <div
            style={{
              fontSize: 6.5,
              fontWeight: 700,
              letterSpacing: '0.12em',
              textTransform: 'uppercase',
              color: accent,
              marginBottom: 6,
            }}
          >
            Budget Context
          </div>
          <div style={{ border: '1px solid #e5e7eb', borderRadius: 3, overflow: 'hidden' }}>
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  padding: '4px 8px',
                  background: i % 2 === 0 ? '#f9fafb' : '#fff',
                  borderTop: i ? '1px solid #e5e7eb' : 'none',
                  gap: 6,
                }}
              >
                <div style={{ flex: 1, height: 3.5, borderRadius: 1.5, background: '#d1d5db' }} />
                <div
                  style={{
                    width: 22,
                    height: 4.5,
                    borderRadius: 1.5,
                    background: i === 2 ? accent : '#9ca3af',
                  }}
                />
              </div>
            ))}
          </div>
        </div>
        <div>
          <div
            style={{
              fontSize: 6.5,
              fontWeight: 700,
              letterSpacing: '0.12em',
              textTransform: 'uppercase',
              color: accent,
              marginBottom: 5,
            }}
          >
            Program Overview
          </div>
          <L />
          <L w="88%" mt={3} />
          <L w="93%" mt={3} />
        </div>
        <div>
          <div
            style={{
              fontSize: 6.5,
              fontWeight: 700,
              letterSpacing: '0.12em',
              textTransform: 'uppercase',
              color: accent,
              marginBottom: 5,
            }}
          >
            The Ask
          </div>
          <div
            style={{
              padding: '7px 9px',
              background: '#f0f4ff',
              border: '1px solid #c7d3f5',
              borderRadius: 3,
            }}
          >
            <div
              style={{
                width: '60%',
                height: 5,
                borderRadius: 2,
                background: accent,
                opacity: 0.65,
                marginBottom: 3,
              }}
            />
            <L w="80%" bg="#94a3b8" />
          </div>
        </div>
      </div>
    </div>
  ) : (
    <div
      style={{
        width: W,
        height: H,
        background: '#fff',
        fontFamily,
        boxSizing: 'border-box',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div
        style={{
          height: 44,
          background: accent,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          padding: '0 20px',
          gap: 8,
        }}
      >
        <div
          style={{ width: 110, height: 6, borderRadius: 2, background: 'rgba(255,255,255,0.9)' }}
        />
        <div style={{ flex: 1 }} />
        <div
          style={{ width: 40, height: 4, borderRadius: 2, background: 'rgba(255,255,255,0.5)' }}
        />
      </div>
      <div style={{ padding: '16px 24px 0', flexShrink: 0 }}>
        <div
          style={{
            width: '74%',
            height: 13,
            borderRadius: 2,
            background: '#1e293b',
            marginBottom: 5,
          }}
        />
        <div
          style={{
            width: '48%',
            height: 5,
            borderRadius: 2,
            background: '#64748b',
            marginBottom: 14,
          }}
        />
      </div>
      <div
        style={{
          flex: 1,
          padding: '0 24px',
          display: 'flex',
          flexDirection: 'column',
          gap: 11,
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            padding: '8px 11px',
            background: 'rgba(42,111,219,0.08)',
            borderLeft: '3px solid ' + accent,
            borderRadius: '0 4px 4px 0',
          }}
        >
          <div
            style={{
              fontSize: 6.5,
              fontWeight: 800,
              color: accent,
              letterSpacing: '0.1em',
              marginBottom: 5,
            }}
          >
            THE BOTTOM LINE
          </div>
          <L bg="#94a3b8" />
          <L w="84%" mt={3} bg="#94a3b8" />
        </div>
        {['Background', 'The Ask', 'Why Now'].map((sec, i) => (
          <div key={sec} style={{ paddingLeft: 9, borderLeft: '2px solid #e2e8f0' }}>
            <div style={{ fontSize: 7, fontWeight: 700, color: '#334155', marginBottom: 4 }}>
              {sec}
            </div>
            <L bg="#cbd5e1" />
            <L w={i === 1 ? '68%' : '89%'} mt={3} bg="#cbd5e1" />
            {i === 0 && <L w="82%" mt={3} bg="#cbd5e1" />}
          </div>
        ))}
        <div
          style={{
            padding: '7px 10px',
            background: '#f8fafc',
            borderRadius: 4,
            border: '1px solid #e2e8f0',
          }}
        >
          <div
            style={{
              fontSize: 6.5,
              fontWeight: 700,
              color: '#64748b',
              marginBottom: 6,
              letterSpacing: '0.08em',
            }}
          >
            SUPPORTING DATA
          </div>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 5, height: 28 }}>
            {[38, 55, 52, 72, 88].map((h, i) => (
              <div
                key={i}
                style={{
                  flex: 1,
                  height: h + '%',
                  background: i === 4 ? accent : '#cbd5e1',
                  borderRadius: '2px 2px 0 0',
                }}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
  return (
    <div
      style={{
        width: Math.round(W * sc),
        height: Math.round(H * sc),
        overflow: 'hidden',
        borderRadius: 5,
        boxShadow: '0 1px 6px rgba(0,0,0,0.13)',
        flexShrink: 0,
      }}
    >
      <div
        style={{ transform: 'scale(' + sc + ')', transformOrigin: 'top left', width: W, height: H }}
      >
        {pageContent}
      </div>
    </div>
  );
}

// ── TemplatesPicker (asset_13) ─────────────────────────────────────────────────
function TemplatesPicker({ cfg, update }: { cfg: WsConfig; update: (p: ConfigPatch) => void }) {
  const [mode, setMode] = useState<'predefined' | 'own'>('predefined');
  const [modalTpl, setModalTpl] = useState<WsTemplate | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [search, setSearch] = useState('');
  const { data: tpls } = useTemplatesFor(cfg.product);
  // Search spans the FULL tenant template library (all products); the two
  // recommendation cards below stay product-specific (tpls.primary/secondary).
  const { data: libTpls } = useAllTemplates();
  const libraryTemplates = useMemo(() => libTpls ?? [], [libTpls]);
  const meriPrimary = tpls?.primary ?? null;
  const meriSecondary = tpls?.secondary ?? null;
  const searchResults = search.trim()
    ? libraryTemplates.filter((t) =>
        (t.name + ' ' + (t.description ?? '') + ' ' + t.product)
          .toLowerCase()
          .includes(search.toLowerCase()),
      )
    : libraryTemplates;
  const applyTemplate = (tpl: WsTemplate) => {
    update({ selectedTemplate: tpl.id, sections: tpl.sections });
    setModalTpl(null);
  };
  const ModeBtn = ({ m, label }: { m: 'predefined' | 'own'; label: string }) => (
    <button
      onClick={() => {
        setMode(m);
        if (m === 'own') update({ selectedTemplate: null });
      }}
      style={{
        flex: 1,
        padding: '7px 0',
        border: '1px solid',
        fontFamily: 'var(--font-sans)',
        borderColor: mode === m ? 'var(--accent)' : 'var(--border-1)',
        background: mode === m ? 'var(--accent-soft)' : 'var(--bg-surface)',
        color: mode === m ? 'var(--accent-ink)' : 'var(--ink-2)',
        borderRadius: 7,
        fontWeight: 600,
        fontSize: 12,
        cursor: 'pointer',
      }}
    >
      {label}
    </button>
  );
  const SuggestionCard = ({ tpl, label }: { tpl: WsTemplate; label?: string }) => {
    const isActive = cfg.selectedTemplate === tpl.id;
    return (
      <div
        onClick={() => setModalTpl(tpl)}
        style={{ display: 'flex', flexDirection: 'column', gap: 10, cursor: 'pointer', flex: 1 }}
      >
        <div
          style={{
            border: '2px solid',
            borderColor: isActive ? 'var(--accent)' : 'var(--border-1)',
            borderRadius: 8,
            overflow: 'hidden',
            transition: 'border-color 0.15s',
          }}
        >
          <DocThumbnail tpl={tpl} scale={0.41} />
        </div>
        <div>
          {label && (
            <div
              style={{
                fontSize: 9,
                fontWeight: 700,
                textTransform: 'uppercase',
                letterSpacing: '0.09em',
                color: 'var(--accent)',
                marginBottom: 3,
              }}
            >
              {label}
            </div>
          )}
          <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--ink-1)', marginBottom: 3 }}>
            {tpl.name}
          </div>
          <div style={{ fontSize: 11, color: 'var(--ink-3)', lineHeight: 1.45 }}>
            {tpl.description}
          </div>
          {isActive && (
            <div
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                marginTop: 5,
                fontSize: 11,
                fontWeight: 600,
                color: 'var(--accent)',
              }}
            >
              <Icon name="Check" size={12} />
              Applied
            </div>
          )}
        </div>
      </div>
    );
  };
  return (
    <QCard title="Templates">
      <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
        <ModeBtn m="predefined" label="Choose a template" />
        <ModeBtn m="own" label="Create your own" />
      </div>
      {mode === 'predefined' && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 14 }}>
            <Icon name="Sparkles" size={13} style={{ color: 'var(--accent)' }} />
            <span style={{ fontSize: 11.5, color: 'var(--ink-2)' }}>
              Meri suggests for <b>{cfg.product}</b>.{' '}
              <span style={{ color: 'var(--ink-3)' }}>
                Everything can be modified in the editor.
              </span>
            </span>
          </div>
          {!showAll ? (
            <>
              <div style={{ display: 'flex', gap: 14, marginBottom: 14, alignItems: 'flex-start' }}>
                {meriPrimary && <SuggestionCard tpl={meriPrimary} label="Recommended" />}
                {meriSecondary && <SuggestionCard tpl={meriSecondary} label="Alternative" />}
              </div>
              {modalTpl && (
                <div
                  style={{
                    position: 'fixed',
                    inset: 0,
                    zIndex: 200,
                    background: 'rgba(0,0,0,0.5)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                  onClick={() => setModalTpl(null)}
                >
                  <div
                    className="card"
                    style={{
                      display: 'flex',
                      gap: 0,
                      maxWidth: 820,
                      width: '92vw',
                      maxHeight: '90vh',
                      overflow: 'hidden',
                      boxShadow: 'var(--shadow-3)',
                      padding: 0,
                    }}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <div
                      style={{
                        background: '#f1f5f9',
                        padding: 28,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        flexShrink: 0,
                      }}
                    >
                      <DocThumbnail tpl={modalTpl} scale={0.72} />
                    </div>
                    <div
                      style={{
                        flex: 1,
                        padding: 28,
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 14,
                        minWidth: 0,
                        overflow: 'auto',
                      }}
                    >
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'flex-start',
                          justifyContent: 'space-between',
                          gap: 12,
                        }}
                      >
                        <div>
                          <div style={{ fontSize: 17, fontWeight: 700, marginBottom: 6 }}>
                            {modalTpl.name}
                          </div>
                          <div style={{ fontSize: 12.5, color: 'var(--ink-2)', lineHeight: 1.55 }}>
                            {modalTpl.description}
                          </div>
                        </div>
                        <button
                          onClick={() => setModalTpl(null)}
                          style={{
                            border: 'none',
                            background: 'none',
                            cursor: 'pointer',
                            color: 'var(--ink-3)',
                            flexShrink: 0,
                            padding: 4,
                          }}
                        >
                          <Icon name="X" size={18} />
                        </button>
                      </div>
                      <div style={{ paddingTop: 14, borderTop: '1px solid var(--border-1)' }}>
                        <div
                          style={{
                            fontSize: 11,
                            fontWeight: 700,
                            textTransform: 'uppercase',
                            letterSpacing: '0.08em',
                            color: 'var(--ink-3)',
                            marginBottom: 10,
                          }}
                        >
                          Included sections
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                          {modalTpl.sections.map((s, i) => (
                            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                              <div
                                style={{
                                  width: 20,
                                  height: 20,
                                  borderRadius: 5,
                                  background: modalTpl.accentColor || 'var(--accent)',
                                  display: 'grid',
                                  placeItems: 'center',
                                  flexShrink: 0,
                                  opacity: 0.15 + i * 0.12,
                                }}
                              />
                              <span style={{ fontSize: 13, fontWeight: 500 }}>{s}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                      {modalTpl.elements && modalTpl.elements.length > 0 && (
                        <div style={{ paddingTop: 14, borderTop: '1px solid var(--border-1)' }}>
                          <div
                            style={{
                              fontSize: 11,
                              fontWeight: 700,
                              textTransform: 'uppercase',
                              letterSpacing: '0.08em',
                              color: 'var(--ink-3)',
                              marginBottom: 8,
                            }}
                          >
                            Supported elements
                          </div>
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                            {modalTpl.elements.map((el) => (
                              <span
                                key={el}
                                style={{
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  gap: 5,
                                  padding: '3px 9px',
                                  borderRadius: 20,
                                  background: 'var(--bg-surface-2)',
                                  border: '1px solid var(--border-1)',
                                  fontSize: 11.5,
                                  fontWeight: 500,
                                  color: 'var(--ink-2)',
                                }}
                              >
                                <Icon
                                  name={
                                    el === 'Tables'
                                      ? 'Table'
                                      : el === 'Charts'
                                        ? 'BarChart2'
                                        : el === 'Logos'
                                          ? 'Building2'
                                          : el === 'Photos'
                                            ? 'Image'
                                            : el === 'Budget exhibit'
                                              ? 'DollarSign'
                                              : el === 'Cover letter'
                                                ? 'Mail'
                                                : 'File'
                                  }
                                  size={11}
                                />
                                {el}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}
                      <div
                        style={{
                          marginTop: 'auto',
                          display: 'flex',
                          gap: 8,
                          paddingTop: 14,
                          borderTop: '1px solid var(--border-1)',
                        }}
                      >
                        <button
                          className="btn btn-accent"
                          onClick={() => applyTemplate(modalTpl)}
                          style={{ flex: 1, justifyContent: 'center' }}
                        >
                          <Icon name="Check" size={14} />
                          Use this template
                        </button>
                        <button className="btn" onClick={() => setModalTpl(null)}>
                          Cancel
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              )}
              <button
                onClick={() => setShowAll(true)}
                style={{
                  fontSize: 11.5,
                  color: 'var(--accent)',
                  fontWeight: 600,
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  padding: '2px 0',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 5,
                }}
              >
                <Icon name="Search" size={12} />
                Search all templates ({libraryTemplates.length})
              </button>
            </>
          ) : (
            <>
              <div style={{ position: 'relative', marginBottom: 12 }}>
                <div
                  className="field"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '8px 11px',
                    background: 'var(--bg-surface)',
                  }}
                >
                  <Icon name="Search" size={14} style={{ color: 'var(--ink-3)' }} />
                  <input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search all templates…"
                    style={{
                      flex: 1,
                      border: 'none',
                      outline: 'none',
                      background: 'transparent',
                      fontSize: 12.5,
                      fontFamily: 'var(--font-sans)',
                    }}
                    autoFocus
                  />
                  <button
                    onClick={() => {
                      setShowAll(false);
                      setSearch('');
                    }}
                    style={{
                      border: 'none',
                      background: 'none',
                      cursor: 'pointer',
                      color: 'var(--ink-4)',
                    }}
                  >
                    <Icon name="X" size={13} />
                  </button>
                </div>
              </div>
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 9,
                  maxHeight: 320,
                  overflow: 'auto',
                }}
              >
                {searchResults.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => {
                      applyTemplate(t);
                      setShowAll(false);
                    }}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 12,
                      padding: '8px 10px',
                      border: '1px solid',
                      borderColor:
                        cfg.selectedTemplate === t.id ? 'var(--accent)' : 'var(--border-1)',
                      background:
                        cfg.selectedTemplate === t.id ? 'var(--accent-soft)' : 'var(--bg-surface)',
                      borderRadius: 8,
                      cursor: 'pointer',
                      textAlign: 'left',
                    }}
                  >
                    <div
                      style={{
                        width: 32,
                        height: 32,
                        borderRadius: 7,
                        background: t.accentColor || 'var(--bg-surface-2)',
                        display: 'grid',
                        placeItems: 'center',
                        flexShrink: 0,
                      }}
                    >
                      <Icon name={t.icon || 'File'} size={15} style={{ color: '#fff' }} />
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12.5, fontWeight: 600 }}>{t.name}</div>
                      <div style={{ fontSize: 11, color: 'var(--ink-3)' }}>{t.product}</div>
                    </div>
                    {cfg.selectedTemplate === t.id && (
                      <Icon
                        name="Check"
                        size={14}
                        style={{ color: 'var(--accent)', flexShrink: 0 }}
                      />
                    )}
                  </button>
                ))}
              </div>
            </>
          )}
        </>
      )}
      {mode === 'own' && <OwnSectionBuilder cfg={cfg} update={update} />}
    </QCard>
  );
}

// ── OwnSectionBuilder (asset_13) ───────────────────────────────────────────────
function OwnSectionBuilder({ cfg, update }: { cfg: WsConfig; update: (p: ConfigPatch) => void }) {
  const [custom, setCustom] = useState('');
  const { data: library } = useSectionLibrary();
  const lib = (library ?? []).filter((s) => !cfg.sections.includes(s));
  const removeSec = (name: string) => update({ sections: cfg.sections.filter((x) => x !== name) });
  const addSec = (name: string) => {
    const v = (name || '').trim();
    if (v && !cfg.sections.includes(v)) update({ sections: [...cfg.sections, v] });
  };
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
        <Icon name="Sparkles" size={13} style={{ color: 'var(--accent)' }} />
        <span style={{ fontSize: 11.5, color: 'var(--ink-2)' }}>
          Build your own structure. Meri drafts each section from your context.
        </span>
        <a
          onClick={() => update({ sections: suggestedSections(cfg.product) })}
          style={{
            marginLeft: 'auto',
            fontSize: 11,
            color: 'var(--accent)',
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          Reset
        </a>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7, marginBottom: lib.length ? 12 : 8 }}>
        {cfg.sections.map((name) => (
          <span
            key={name}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 7,
              padding: '6px 8px 6px 11px',
              borderRadius: 7,
              border: '1px solid var(--accent)',
              background: 'var(--accent-soft)',
              color: 'var(--accent-ink)',
              fontSize: 12.5,
              fontWeight: 600,
            }}
          >
            {name}
            <button
              onClick={() => removeSec(name)}
              style={{
                border: 'none',
                background: 'none',
                cursor: 'pointer',
                display: 'grid',
                placeItems: 'center',
                color: 'var(--accent-ink)',
                padding: 0,
              }}
            >
              <Icon name="X" size={13} />
            </button>
          </span>
        ))}
      </div>
      {lib.length > 0 && (
        <>
          <div style={{ fontSize: 11, color: 'var(--ink-3)', marginBottom: 7 }}>
            Add from library
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7, marginBottom: 12 }}>
            {lib.map((s) => (
              <button
                key={s}
                onClick={() => addSec(s)}
                className="btn sm"
                style={{ borderStyle: 'dashed', color: 'var(--ink-2)' }}
              >
                <Icon name="Plus" size={12} />
                {s}
              </button>
            ))}
          </div>
        </>
      )}
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              addSec(custom);
              setCustom('');
            }
          }}
          placeholder="Write your own section name"
          className="field"
          style={{
            flex: 1,
            padding: '8px 12px',
            fontSize: 12.5,
            fontFamily: 'var(--font-sans)',
            background: 'var(--bg-surface)',
          }}
        />
        <button
          className="btn sm"
          onClick={() => {
            addSec(custom);
            setCustom('');
          }}
          disabled={!custom.trim()}
          style={{ opacity: custom.trim() ? 1 : 0.5 }}
        >
          <Icon name="Plus" size={12} />
          Add
        </button>
      </div>
    </div>
  );
}

// ── shared picker helpers ──────────────────────────────────────────────────────
/** Initials from a person's name (matches the prototype's Ava fallback). */
function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .map((x) => x[0])
    .filter(Boolean)
    .slice(-2)
    .join('')
    .toUpperCase();
}
function MiniAva({ x, size = 26 }: { x: string; size?: number }) {
  return (
    <span
      className="num"
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        background: 'linear-gradient(135deg,#4E78D8,#1A3F9F)',
        color: '#fff',
        display: 'inline-grid',
        placeItems: 'center',
        fontSize: size * 0.4,
        fontWeight: 600,
        flex: 'none',
        boxShadow: '0 0 0 1.5px var(--bg-surface)',
      }}
    >
      {x}
    </span>
  );
}

// ── OfficePicker — searches OUR congressional directory (GET /api/directory/contacts) ─
interface DirContact {
  id: string;
  fullName: string;
  memberName: string;
  chamber: string;
  state: string;
  district: string;
  party: string;
}
interface DirContactsResponse {
  contacts: DirContact[];
}
function OfficePicker({
  cfg,
  client,
  update,
}: {
  cfg: WsConfig;
  client: string | null;
  update: (p: ConfigPatch) => void;
}) {
  const api = useApi();
  const [q, setQ] = useState('');
  const offices = cfg.offices ?? [];

  // Members directory search — live against our directory contacts endpoint.
  // Debounced (one request per typing pause, not per keystroke) and prior
  // results are kept while the next request resolves so the dropdown doesn't
  // flicker empty — this is what made the search feel broken / minutes-slow.
  const dq = useDebouncedValue(q.trim(), 250);
  const { data } = useQuery({
    queryKey: ['ws-office-search', dq],
    enabled: dq.length > 0,
    placeholderData: (prev) => prev,
    queryFn: async () =>
      (
        await api.get<DirContactsResponse>('/api/directory/contacts', {
          params: { q: dq, pageSize: 6, sort: 'name-asc' },
        })
      ).data,
  });
  const results = (data?.contacts ?? []).filter((o) => !offices.includes(o.fullName)).slice(0, 6);

  const removeOffice = (who: string) => update({ offices: offices.filter((x) => x !== who) });
  const addOffice = (who: string) => {
    if (!offices.includes(who)) update({ offices: [...offices, who] });
    setQ('');
  };

  return (
    <div style={{ paddingTop: 14, borderTop: '1px solid var(--border-1)' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 7, marginBottom: 8 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink-2)' }}>Target offices</div>
        {client && (
          <span style={{ fontSize: 11, color: 'var(--ink-3)' }}>
            members of Congress for {client}
          </span>
        )}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 7, marginBottom: 10 }}>
        {offices.map((who) => (
          <div
            key={who}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '9px 11px',
              border: '1px solid var(--border-1)',
              background: 'var(--bg-surface)',
              borderRadius: 8,
            }}
          >
            <MiniAva x={initialsOf(who)} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12.5, fontWeight: 600 }}>{who}</div>
            </div>
            <button
              onClick={() => removeOffice(who)}
              title="Remove"
              style={{
                border: 'none',
                background: 'none',
                cursor: 'pointer',
                color: 'var(--ink-4)',
                display: 'grid',
                placeItems: 'center',
                padding: 2,
              }}
            >
              <Icon name="X" size={14} />
            </button>
          </div>
        ))}
        {offices.length === 0 && (
          <div style={{ fontSize: 12, color: 'var(--ink-3)', padding: '8px 0' }}>
            No offices selected. Search the directory below.
          </div>
        )}
      </div>
      <div style={{ position: 'relative' }}>
        <div
          className="field"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '8px 11px',
            background: 'var(--bg-surface)',
          }}
        >
          <Icon name="Search" size={14} style={{ color: 'var(--ink-3)' }} />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search by name, district, or committee"
            style={{
              flex: 1,
              border: 'none',
              outline: 'none',
              background: 'transparent',
              fontSize: 12.5,
              fontFamily: 'var(--font-sans)',
            }}
          />
        </div>
        {/* Gate on the debounced query too: placeholderData keeps prior results
            across key changes, so without this the menu would stay open over an
            empty input after a selection/clear. */}
        {dq.length > 0 && results.length > 0 && (
          <div
            className="card"
            style={{
              position: 'absolute',
              top: 'calc(100% + 4px)',
              left: 0,
              right: 0,
              zIndex: 20,
              padding: 5,
              boxShadow: 'var(--shadow-2)',
            }}
          >
            {results.map((o) => (
              <button
                key={o.id}
                onClick={() => addOffice(o.fullName)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  width: '100%',
                  textAlign: 'left',
                  padding: '7px 8px',
                  border: 'none',
                  background: 'transparent',
                  borderRadius: 6,
                  cursor: 'pointer',
                  font: 'inherit',
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-surface-2)')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
              >
                <MiniAva x={initialsOf(o.fullName)} size={22} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12, fontWeight: 600 }}>{o.fullName}</div>
                  <div style={{ fontSize: 10.5, color: 'var(--ink-3)' }} className="num">
                    {[o.state, o.district ? 'Dist ' + o.district : '', o.chamber]
                      .filter(Boolean)
                      .join(' · ')}
                  </div>
                </div>
                <Icon name="Plus" size={13} style={{ color: 'var(--accent)' }} />
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── LinkedDataCard (asset_13) — NO strategy row (Strategies deleted) ───────────
/** Shared dropdown/typeahead row style for the Links & data menus. */
const MENU_ROW: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  width: '100%',
  textAlign: 'left',
  padding: '7px 8px',
  border: 'none',
  background: 'transparent',
  borderRadius: 6,
  cursor: 'pointer',
  font: 'inherit',
};

/**
 * Select client (required, top of Setup). The client scopes every Context
 * Builder source (overview/capabilities/facilities/documents/offices news) and
 * Meri generation, so it must be chosen before building context. Persists the
 * client NAME on draft.client via setClient.
 */
function ClientSelectCard({
  client,
  setClient,
}: {
  client: string | null;
  setClient: (name: string | null) => void;
}) {
  const api = useApi();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const boxRef = useRef<HTMLDivElement>(null);
  const { data: clients } = useQuery({
    queryKey: ['ws-clients-list'],
    queryFn: async () => (await api.get<{ id: string; name: string }[]>('/api/clients')).data,
  });
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);
  const filtered = (clients ?? []).filter(
    (c) => !q.trim() || c.name.toLowerCase().includes(q.toLowerCase()),
  );
  return (
    <QCard title="Select client">
      <div style={{ fontSize: 12.5, color: 'var(--ink-2)', marginBottom: 10 }}>
        Choose the client this work product is for.{' '}
        <span style={{ color: 'var(--danger, #c0392b)', fontWeight: 600 }}>Required</span> — Meri
        builds context from this client&rsquo;s profile, documents, and offices.
      </div>
      <div ref={boxRef} style={{ position: 'relative', maxWidth: 460 }}>
        <div
          className="field"
          onClick={() => setOpen((o) => !o)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 9,
            padding: '10px 12px',
            cursor: 'pointer',
            background: 'var(--bg-surface)',
            borderColor: client ? 'var(--border-1)' : 'var(--accent)',
          }}
        >
          <Icon name="Building2" size={15} style={{ color: 'var(--ink-3)' }} />
          <span style={{ flex: 1, fontSize: 13, color: client ? 'var(--ink-1)' : 'var(--ink-3)' }}>
            {client || 'Select a client…'}
          </span>
          <Icon name="ChevronDown" size={15} style={{ color: 'var(--ink-3)' }} />
        </div>
        {open && (
          <div
            className="card"
            style={{
              position: 'absolute',
              top: 'calc(100% + 4px)',
              left: 0,
              right: 0,
              zIndex: 30,
              padding: 5,
              maxHeight: 300,
              overflow: 'auto',
              boxShadow: 'var(--shadow-2)',
            }}
          >
            <div
              className="field"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '7px 10px',
                margin: '2px 2px 6px',
                background: 'var(--bg-surface)',
              }}
            >
              <Icon name="Search" size={13} style={{ color: 'var(--ink-3)' }} />
              <input
                autoFocus
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search clients"
                style={{
                  flex: 1,
                  border: 'none',
                  outline: 'none',
                  background: 'transparent',
                  fontSize: 12.5,
                  fontFamily: 'var(--font-sans)',
                }}
              />
            </div>
            {filtered.map((c) => (
              <button
                key={c.id}
                onClick={() => {
                  setClient(c.name);
                  setOpen(false);
                  setQ('');
                }}
                style={MENU_ROW}
                onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-surface-2)')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
              >
                <Icon name="Building2" size={13} style={{ color: 'var(--ink-3)' }} />
                <span style={{ flex: 1, fontSize: 12.5 }}>{c.name}</span>
                {client === c.name && (
                  <Icon name="Check" size={13} style={{ color: 'var(--accent)' }} />
                )}
              </button>
            ))}
            {filtered.length === 0 && (
              <div style={{ fontSize: 11.5, color: 'var(--ink-3)', padding: '8px 10px' }}>
                {(clients ?? []).length === 0 ? 'No clients on file.' : 'No clients match.'}
              </div>
            )}
          </div>
        )}
      </div>
    </QCard>
  );
}

/** Format a budget value for the PE context block (no unit assumption). */
function peNum(v: string | number | null | undefined): string | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  if (Number.isFinite(n)) return n.toLocaleString('en-US');
  return typeof v === 'string' ? v : null;
}

/**
 * Build the "everything associated with this program element" context block the
 * user asked for — identifiers + mission narrative (R-2A projects) + the recent
 * FY financial history. Persisted on the draft and fed to Meri generation.
 */
function formatPeContext(d: ProgramElementDetail, projects: ProgramElementProject[]): string {
  const lines: string[] = [];
  const ids = [d.service, d.appropriationType, d.budgetActivity, d.status].filter(
    Boolean,
  ) as string[];
  if (ids.length) lines.push(ids.join(' · '));
  // PE-level mission/description (the program narrative parsed at ingestion) —
  // the single most useful grounding text for Meri. Clamped so a long R-doc
  // narrative can't dominate the context budget.
  const peDescription = d.description?.trim();
  if (peDescription) lines.push('Program: ' + peDescription.slice(0, 1200));
  // R-2A project-level missions (sub-elements), if any.
  const missions = projects.map((p) => p.mission?.trim()).filter((m): m is string => Boolean(m));
  if (missions.length) lines.push('Mission: ' + missions.slice(0, 2).join(' '));
  const years = (d.years ?? [])
    .slice()
    .sort((a, b) => a.fy - b.fy)
    .slice(-4);
  for (const y of years) {
    const parts: string[] = [];
    const req = peNum(y.request);
    if (req) parts.push('request ' + req);
    const en = peNum(y.enacted);
    if (en) parts.push('enacted ' + en);
    if (parts.length) lines.push(`FY${y.fy}: ${parts.join(', ')}`);
  }
  return lines.join('\n');
}

function LinkedDataCard({ cfg, update }: { cfg: WsConfig; update: (p: ConfigPatch) => void }) {
  const api = useApi();
  const { data: defaults } = useProductDefaults(cfg.product);
  const ask = (cfg.ask as { amount?: string; pb?: string; delta?: string } | undefined) ?? {};
  const isFunding = !!defaults?.funding;
  // Optimistic ref so the three debounced ask fields (amount/pb/delta) merge
  // against the freshest value instead of clobbering each other (cfg.ask is
  // shallow-replaced on save, same as the letterhead object).
  const askRef = useRef(ask);
  useEffect(() => {
    askRef.current =
      (cfg.ask as { amount?: string; pb?: string; delta?: string } | undefined) ?? {};
  }, [cfg.ask]);
  const setAsk = (key: 'amount' | 'pb' | 'delta', v: string) => {
    const next = { ...askRef.current, [key]: v };
    askRef.current = next;
    update({ ask: next });
  };

  // ── Program-element search (#5): the only platform-data control now. Search
  // our program elements; selecting one pulls the full associated context
  // (mission + FY financials) and persists it for Meri generation.
  const linkedPes = (cfg.linkedProgramElements as WsLinkedProgramElement[] | undefined) ?? [];
  // Optimistic ref so two PEs added in quick succession (addPe awaits a network
  // round-trip before persisting) merge instead of clobbering each other under
  // the engine's shallow config replace.
  const linkedPesRef = useRef(linkedPes);
  useEffect(() => {
    linkedPesRef.current =
      (cfg.linkedProgramElements as WsLinkedProgramElement[] | undefined) ?? [];
  }, [cfg.linkedProgramElements]);
  const [peQuery, setPeQuery] = useState('');
  const dpe = useDebouncedValue(peQuery.trim(), 300);
  const [peLoading, setPeLoading] = useState(false);
  const { data: peResults } = useQuery({
    queryKey: ['ws-pe-search', dpe],
    enabled: dpe.length > 1,
    placeholderData: (prev) => prev,
    queryFn: async () =>
      (await getProgramElementsList(api, { q: dpe, limit: 8, has_data: 'true' })).data,
  });
  const peHits = (peResults ?? []).filter((p) => !linkedPes.some((l) => l.peCode === p.peCode));

  const addPe = async (peCode: string, title: string, service: string | null) => {
    if (linkedPesRef.current.some((l) => l.peCode === peCode)) return;
    setPeLoading(true);
    let context = '';
    try {
      const [detail, projects] = await Promise.all([
        getProgramElementDetail(api, peCode),
        getProgramElementProjects(api, peCode).catch(() => [] as ProgramElementProject[]),
      ]);
      context = formatPeContext(detail, projects);
    } catch {
      context = `${peCode} — ${title}`;
    } finally {
      setPeLoading(false);
    }
    const next = [...linkedPesRef.current, { peCode, title, service, context }];
    linkedPesRef.current = next;
    update({ linkedProgramElements: next });
    setPeQuery('');
  };
  const removePe = (peCode: string) => {
    const next = linkedPesRef.current.filter((l) => l.peCode !== peCode);
    linkedPesRef.current = next;
    update({ linkedProgramElements: next });
  };

  return (
    <QCard title="Links & data">
      {/* Program elements (#5) — search PEs; selection pulls full context */}
      <div style={{ marginTop: 16 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 11.5,
            fontWeight: 600,
            color: 'var(--ink-2)',
            marginBottom: 7,
          }}
        >
          <Icon name="Database" size={12} style={{ color: 'var(--accent)' }} />
          Program elements
          <span style={{ fontWeight: 400, color: 'var(--ink-3)' }}>
            — search to attach budget context (mission, financials)
          </span>
        </div>

        {linkedPes.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7, marginBottom: 9 }}>
            {linkedPes.map((pe) => (
              <div
                key={pe.peCode}
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 10,
                  padding: '9px 11px',
                  border: '1px solid var(--border-1)',
                  background: 'var(--bg-surface)',
                  borderRadius: 8,
                }}
              >
                <Icon
                  name="Database"
                  size={14}
                  style={{ color: 'var(--accent)', marginTop: 2, flexShrink: 0 }}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 600 }}>
                    <span className="num">{pe.peCode}</span> — {pe.title}
                  </div>
                  {pe.context && (
                    <div
                      style={{
                        fontSize: 11,
                        color: 'var(--ink-3)',
                        marginTop: 3,
                        whiteSpace: 'pre-wrap',
                        maxHeight: 84,
                        overflow: 'auto',
                        lineHeight: 1.45,
                      }}
                    >
                      {pe.context}
                    </div>
                  )}
                </div>
                <button
                  onClick={() => removePe(pe.peCode)}
                  title="Remove"
                  style={{
                    border: 'none',
                    background: 'none',
                    cursor: 'pointer',
                    color: 'var(--ink-4)',
                    display: 'grid',
                    placeItems: 'center',
                    padding: 2,
                    flexShrink: 0,
                  }}
                >
                  <Icon name="X" size={14} />
                </button>
              </div>
            ))}
          </div>
        )}

        <div style={{ position: 'relative' }}>
          <div
            className="field"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '8px 11px',
              background: 'var(--bg-surface)',
            }}
          >
            <Icon name="Search" size={14} style={{ color: 'var(--ink-3)' }} />
            <input
              value={peQuery}
              onChange={(e) => setPeQuery(e.target.value)}
              placeholder="Search program elements by PE code or title"
              style={{
                flex: 1,
                border: 'none',
                outline: 'none',
                background: 'transparent',
                fontSize: 12.5,
                fontFamily: 'var(--font-sans)',
              }}
            />
            {peLoading && <Spin size="small" />}
          </div>
          {dpe.length > 1 && peHits.length > 0 && (
            <div
              className="card"
              style={{
                position: 'absolute',
                top: 'calc(100% + 4px)',
                left: 0,
                right: 0,
                zIndex: 20,
                padding: 5,
                maxHeight: 300,
                overflow: 'auto',
                boxShadow: 'var(--shadow-2)',
              }}
            >
              {peHits.map((p) => (
                <button
                  key={p.peCode}
                  onClick={() => addPe(p.peCode, p.title, p.service)}
                  style={MENU_ROW}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-surface-2)')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 600 }}>
                      <span className="num">{p.peCode}</span> — {p.title}
                    </div>
                    <div style={{ fontSize: 10.5, color: 'var(--ink-3)' }}>
                      {[p.service, p.appropriationType].filter(Boolean).join(' · ')}
                    </div>
                  </div>
                  <Icon name="Plus" size={13} style={{ color: 'var(--accent)', flexShrink: 0 }} />
                </button>
              ))}
            </div>
          )}
          {dpe.length > 1 && peResults && peHits.length === 0 && (
            <div
              style={{
                fontSize: 11.5,
                color: 'var(--ink-3)',
                padding: '8px 2px',
                fontStyle: 'italic',
              }}
            >
              No program elements found for &ldquo;{dpe}&rdquo;.
            </div>
          )}
        </div>
      </div>

      {isFunding && (
        <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--border-1)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 10 }}>
            <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--ink-2)' }}>
              Funding ask
            </span>
            <span style={{ fontSize: 11, color: 'var(--ink-3)', fontStyle: 'italic' }}>
              optional — pre-fills the budget block in the editor
            </span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
            {(
              [
                ['Amount', 'amount', '$18.0M'],
                ['PB', 'pb', '$8.0M'],
                ['Delta', 'delta', '+$10.0M'],
              ] as const
            ).map(([label, key, placeholder]) => (
              <div key={key}>
                <div
                  style={{
                    fontSize: 10,
                    fontWeight: 700,
                    color: 'var(--ink-3)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.06em',
                    marginBottom: 5,
                  }}
                >
                  {label}
                </div>
                <AutosaveField
                  value={ask[key] || ''}
                  onCommit={(v) => setAsk(key, v)}
                  placeholder={placeholder}
                  className="field num"
                  style={{
                    width: '100%',
                    padding: '7px 10px',
                    fontSize: 12.5,
                    fontFamily: 'var(--font-mono)',
                    background: 'var(--bg-surface)',
                    boxSizing: 'border-box',
                  }}
                />
              </div>
            ))}
          </div>
        </div>
      )}
    </QCard>
  );
}

// ── LetterheadCard (asset_13) ──────────────────────────────────────────────────
function LetterheadCard({ cfg, update }: { cfg: WsConfig; update: (p: ConfigPatch) => void }) {
  const lh = cfg.letterhead || { custom: false, firmName: '', firmAddr: '' };
  // Optimistic ref: the letterhead is one object edited by several debounced
  // fields (logo/firmName/firmAddr). The engine shallow-replaces it, so each
  // commit must merge against the freshest value — not a stale render snapshot —
  // or a later field's save would wipe an earlier one.
  const lhRef = useRef(lh);
  useEffect(() => {
    lhRef.current = cfg.letterhead || { custom: false, firmName: '', firmAddr: '' };
  }, [cfg.letterhead]);
  const setLh = (patch: Partial<typeof lh>) => {
    const next = { ...lhRef.current, ...patch };
    lhRef.current = next;
    update({ letterhead: next });
  };
  const fileRef = useRef<HTMLInputElement>(null);
  const [logoErr, setLogoErr] = useState<string | null>(null);
  const field: React.CSSProperties = {
    padding: '8px 12px',
    fontSize: 13,
    fontFamily: 'var(--font-sans)',
    background: 'var(--bg-surface)',
    width: '100%',
  };

  // #7: open the OS file picker, validate, and persist the logo as a base64 data
  // URL on the letterhead config (no separate asset endpoint needed for now).
  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = ''; // allow re-selecting the same file
    if (!f) return;
    // PNG/JPEG only: these embed in the exported DOCX (SVG can't, so accepting
    // it would preview a logo that silently vanishes from the Word output).
    if (!/^image\/(png|jpeg)$/.test(f.type)) {
      setLogoErr('Use a PNG or JPEG image.');
      return;
    }
    if (f.size > 2 * 1024 * 1024) {
      setLogoErr('Logo must be under 2 MB.');
      return;
    }
    setLogoErr(null);
    const reader = new FileReader();
    reader.onload = () => setLh({ logoDataUrl: String(reader.result) });
    reader.onerror = () => setLogoErr('Could not read that file.');
    reader.readAsDataURL(f);
  };

  return (
    <QCard title="Letterhead">
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 14,
          flexWrap: 'wrap',
        }}
      >
        <div style={{ fontSize: 12.5, fontWeight: 600 }}>Use a custom branded letterhead?</div>
        <Seg
          options={[
            ['no', 'No'],
            ['yes', 'Yes'],
          ]}
          value={lh.custom ? 'yes' : 'no'}
          onChange={(v) => setLh({ custom: v === 'yes' })}
        />
      </div>
      {lh.custom && (
        <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <div
              style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--ink-2)', marginBottom: 6 }}
            >
              Logo
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 13, flexWrap: 'wrap' }}>
              <div
                style={{
                  width: 64,
                  height: 64,
                  borderRadius: 8,
                  flex: 'none',
                  border: '1px solid var(--border-1)',
                  overflow: 'hidden',
                  background: lh.logoDataUrl
                    ? 'var(--bg-surface)'
                    : 'repeating-linear-gradient(135deg, var(--bg-surface-2) 0 8px, var(--bg-sunken) 8px 16px)',
                  display: 'grid',
                  placeItems: 'center',
                  fontFamily: 'var(--font-mono)',
                  fontSize: 9,
                  color: 'var(--ink-3)',
                }}
              >
                {lh.logoDataUrl ? (
                  <img
                    src={lh.logoDataUrl}
                    alt="Firm logo"
                    style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
                  />
                ) : (
                  'LOGO'
                )}
              </div>
              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/jpeg"
                style={{ display: 'none' }}
                onChange={onPick}
              />
              <button className="btn sm" type="button" onClick={() => fileRef.current?.click()}>
                <Icon name="Upload" size={13} />
                {lh.logoDataUrl ? 'Replace logo' : 'Upload logo'}
              </button>
              {lh.logoDataUrl && (
                <button
                  className="btn sm btn-ghost"
                  type="button"
                  onClick={() => {
                    setLogoErr(null);
                    setLh({ logoDataUrl: undefined });
                  }}
                  style={{ color: 'var(--ink-2)' }}
                >
                  <Icon name="Trash2" size={13} />
                  Remove
                </button>
              )}
              <span
                style={{ fontSize: 11, color: logoErr ? 'var(--danger, #c0392b)' : 'var(--ink-3)' }}
              >
                {logoErr || 'PNG or JPEG, transparent background'}
              </span>
            </div>
          </div>
          <div>
            <div
              style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--ink-2)', marginBottom: 6 }}
            >
              Firm name
            </div>
            <AutosaveField
              value={lh.firmName || ''}
              onCommit={(v) => setLh({ firmName: v })}
              className="field"
              style={field}
            />
          </div>
          <div>
            <div
              style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--ink-2)', marginBottom: 6 }}
            >
              Address
            </div>
            <AutosaveField
              value={lh.firmAddr || ''}
              onCommit={(v) => setLh({ firmAddr: v })}
              className="field"
              style={field}
            />
          </div>
        </div>
      )}
    </QCard>
  );
}
