import { useEffect, useRef, useState } from 'react';
import { Icon } from './tracker-icons.js';
import {
  TERM_TYPES,
  TERM_TYPE_LABELS,
  TRIGGER_LABELS,
  TRIGGER_ORDER,
  type AlertPrefsPayload,
  type TagPosition,
  type TagPriority,
  type TermType,
  type TypedTerm,
  type WatchlistPayload,
  type WatchlistTag,
} from './tracker-api.js';

const PRIO_CYCLE: Record<TagPriority, TagPriority> = { low: 'med', med: 'high', high: 'low' };
const POS_CYCLE: Record<TagPosition, TagPosition> = {
  support: 'monitor',
  monitor: 'oppose',
  oppose: 'support',
};
const PRIO_LABEL: Record<TagPriority, string> = { low: 'Low', med: 'Med', high: 'High' };
const POS_LABEL: Record<TagPosition, string> = {
  support: 'Support',
  oppose: 'Oppose',
  monitor: 'Monitor',
};

function ChipInput({
  items,
  onChange,
  kind,
  placeholder,
}: {
  items: string[];
  onChange: (items: string[]) => void;
  kind?: 'risk';
  placeholder?: string;
}) {
  const [v, setV] = useState('');
  const add = () => {
    const t = v.trim();
    if (t && !items.includes(t)) onChange([...items, t]);
    setV('');
  };
  return (
    <div
      className="chip-input"
      onClick={(e) => (e.currentTarget.querySelector('input') as HTMLInputElement | null)?.focus()}
    >
      {items.map((it, i) => (
        <span key={`${it}-${i}`} className={`ci-chip${kind === 'risk' ? ' risk' : ''}`}>
          {it}
          <span className="x" onClick={() => onChange(items.filter((_, j) => j !== i))}>
            <Icon name="plus" size={10} style={{ transform: 'rotate(45deg)' }} />
          </span>
        </span>
      ))}
      <input
        className="ci-add"
        value={v}
        placeholder={placeholder || 'Add…'}
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            add();
          }
          if (e.key === 'Backspace' && !v && items.length) onChange(items.slice(0, -1));
        }}
        onBlur={add}
      />
    </div>
  );
}

/**
 * Typed-term sub-editor (P5, plan §5.2). Reads/writes `WatchlistTag.typedTerms`
 * across the full 11 canonical term types. Complements the three legacy chip
 * inputs (Synonyms / Related entities / Risk terms) which own the older
 * `synonym` / `entity` / `risk` types — together they cover every term type.
 * Any UNKNOWN type already on the topic (e.g. a hearing-native type) is shown
 * (read-only label) and preserved so a save never drops it.
 */
function TypedTermEditor({
  terms,
  onChange,
}: {
  terms: TypedTerm[];
  onChange: (terms: TypedTerm[]) => void;
}) {
  const [type, setType] = useState<TermType>('bill');
  const [value, setValue] = useState('');
  const add = () => {
    const v = value.trim();
    if (!v) return;
    if (terms.some((t) => t.termType === type && t.value.toLowerCase() === v.toLowerCase())) {
      setValue('');
      return;
    }
    onChange([...terms, { termType: type, value: v }]);
    setValue('');
  };
  const labelFor = (t: string) => TERM_TYPE_LABELS[t] ?? t;
  return (
    <div className="typed-terms">
      <div className="tt-list">
        {terms.map((t, i) => (
          <span key={`${t.termType}-${t.value}-${i}`} className="tt-chip">
            <span className="tt-type">{labelFor(t.termType)}</span>
            {t.value}
            <span className="x" onClick={() => onChange(terms.filter((_, j) => j !== i))}>
              <Icon name="plus" size={10} style={{ transform: 'rotate(45deg)' }} />
            </span>
          </span>
        ))}
        {terms.length === 0 && <span className="tt-empty">No typed terms yet</span>}
      </div>
      <div className="tt-add">
        <select
          className="tt-select"
          value={type}
          onChange={(e) => setType(e.target.value as TermType)}
        >
          {TERM_TYPES.map((t) => (
            <option key={t} value={t}>
              {labelFor(t)}
            </option>
          ))}
        </select>
        <input
          className="tt-value"
          value={value}
          placeholder="add term…"
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
          onBlur={add}
        />
        <button className="tt-add-btn" onClick={add} type="button">
          <Icon name="plus" size={12} /> Add
        </button>
      </div>
    </div>
  );
}

function TagRow({
  tag,
  open,
  onToggleOpen,
  onChange,
  onDelete,
  typedTermsEnabled,
}: {
  tag: WatchlistTag;
  open: boolean;
  onToggleOpen: () => void;
  onChange: (t: WatchlistTag) => void;
  onDelete: () => void;
  /** Typed terms (the 11 types) only persist via the intel-api save path
   *  (tracker_v2). With the flag off, the legacy path drops them (normalizeTag),
   *  so hide the editor entirely rather than silently lose input (batch-A review). */
  typedTermsEnabled: boolean;
}) {
  const patch = (p: Partial<WatchlistTag>) => onChange({ ...tag, ...p });
  const priority = tag.priority ?? 'med';
  const position = tag.position ?? 'monitor';
  return (
    <div className={`tag-row${open ? ' open' : ''}`}>
      <div className="tag-row-head" onClick={onToggleOpen}>
        <span className="tg-name">
          <span className="hash">#</span>
          {tag.tag || 'new tag'}
        </span>
        <button
          className={`tag-meta-pill prio-${priority}`}
          onClick={(e) => {
            e.stopPropagation();
            patch({ priority: PRIO_CYCLE[priority] });
          }}
          title="Priority — click to change"
        >
          {PRIO_LABEL[priority]}
        </button>
        <button
          className={`tag-meta-pill pos-${position}`}
          onClick={(e) => {
            e.stopPropagation();
            patch({ position: POS_CYCLE[position] });
          }}
          title="Position — click to change"
        >
          {POS_LABEL[position]}
        </button>
        <span className="tg-spacer" />
        <span className="tg-adv">
          <Icon name="settings" size={12} /> Advanced
        </span>
        <span
          className="tg-trash"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          title="Remove tag"
        >
          <Icon name="trash" size={13} />
        </span>
        <span className="tg-chev">
          <Icon name="chev-r" size={15} />
        </span>
      </div>
      {open && (
        <div className="tag-adv-body">
          <div className="adv-field">
            <div className="af-label">Synonyms</div>
            <ChipInput
              items={tag.synonyms}
              onChange={(v) => patch({ synonyms: v })}
              placeholder="add synonym…"
            />
          </div>
          <div className="adv-field">
            <div className="af-label">Related entities</div>
            <ChipInput
              items={tag.relatedEntities}
              onChange={(v) => patch({ relatedEntities: v })}
              placeholder="FERC, PJM…"
            />
          </div>
          <div className="adv-field">
            <div className="af-label">Risk terms</div>
            <ChipInput
              items={tag.riskTerms}
              onChange={(v) => patch({ riskTerms: v })}
              kind="risk"
              placeholder="curtailment…"
            />
          </div>
          {typedTermsEnabled && (
            <div className="adv-field">
              <div className="af-label">
                Typed terms
                <span className="af-hint">
                  {' '}
                  — bills, agencies, committees, legislators, companies, competitors &amp; more
                </span>
              </div>
              <TypedTermEditor
                terms={tag.typedTerms ?? []}
                onChange={(v) => patch({ typedTerms: v })}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function CadenceSeg<T extends string>({
  value,
  onChange,
  opts,
}: {
  value: T;
  onChange: (v: T) => void;
  opts: { v: T; l: string }[];
}) {
  return (
    <div className="cadence-seg">
      {opts.map((o) => (
        <button key={o.v} className={value === o.v ? 'on' : ''} onClick={() => onChange(o.v)}>
          {o.l}
        </button>
      ))}
    </div>
  );
}

export function TrackerConfigPanel({
  allIssueAreas,
  watchlist,
  prefs,
  seed,
  clientName,
  onSaveWatchlist,
  onSavePrefs,
  onRequestVerify,
  onTestAlert,
  typedTermsEnabled = false,
}: {
  allIssueAreas: string[];
  /** LegiWatch v2 (L4): titles the per-user alerts section "Your alerts for [client]". */
  clientName?: string;
  watchlist: WatchlistPayload;
  prefs: AlertPrefsPayload;
  seed?: { tags: WatchlistTag[]; issueAreas: string[] };
  onSaveWatchlist: (w: WatchlistPayload) => void;
  onSavePrefs: (p: AlertPrefsPayload) => void;
  onRequestVerify: (phone: string, onVerified: () => void) => void;
  onTestAlert: (channels: ('email' | 'sms' | 'in_app')[]) => void;
  /** Show the 11-type typed-term editor (only persists via intel-api/tracker_v2). */
  typedTermsEnabled?: boolean;
}) {
  // ── Targeting ──
  const [issues, setIssues] = useState<Set<string>>(() => new Set(watchlist.issueAreas));
  const [tags, setTags] = useState<WatchlistTag[]>(() =>
    watchlist.tags.map((t) => ({
      ...t,
      synonyms: [...t.synonyms],
      relatedEntities: [...t.relatedEntities],
      riskTerms: [...t.riskTerms],
      typedTerms: (t.typedTerms ?? []).map((x) => ({ ...x })),
    })),
  );
  const [openTags, setOpenTags] = useState<Set<number>>(() => new Set(tags.length ? [] : []));

  // ── Alerts ──
  const [triggers, setTriggers] = useState<Set<string>>(() => new Set(prefs.triggers));
  const [materiality, setMateriality] = useState(prefs.materiality);
  const [emailEnabled, setEmailEnabled] = useState(prefs.emailEnabled);
  const [emailAddress, setEmailAddress] = useState(prefs.emailAddress ?? '');
  const [emailCadence, setEmailCadence] = useState(prefs.emailCadence);
  const [smsEnabled, setSmsEnabled] = useState(prefs.smsEnabled);
  const [smsPhone, setSmsPhone] = useState(prefs.smsPhone ?? '');
  const [smsVerified, setSmsVerified] = useState(prefs.smsPhoneVerified);
  const [smsCadence, setSmsCadence] = useState(prefs.smsCadence);
  const [quietStart, setQuietStart] = useState(prefs.quietHoursStart ?? '22:00');
  const [quietEnd, setQuietEnd] = useState(prefs.quietHoursEnd ?? '07:00');

  // Debounced autosave (skip the initial mount).
  const wlMounted = useRef(false);
  useEffect(() => {
    if (!wlMounted.current) {
      wlMounted.current = true;
      return;
    }
    const id = window.setTimeout(
      () => onSaveWatchlist({ issueAreas: Array.from(issues), tags }),
      600,
    );
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [issues, tags]);

  const prefsMounted = useRef(false);
  useEffect(() => {
    if (!prefsMounted.current) {
      prefsMounted.current = true;
      return;
    }
    const id = window.setTimeout(
      () =>
        onSavePrefs({
          triggers: Array.from(triggers),
          materiality,
          emailEnabled,
          emailAddress: emailAddress.trim() || null,
          emailCadence,
          smsEnabled: smsEnabled && smsVerified && !!smsPhone,
          smsPhone: smsPhone.trim() || null,
          smsPhoneVerified: smsVerified,
          smsCadence,
          quietHoursStart: quietStart || null,
          quietHoursEnd: quietEnd || null,
        }),
      600,
    );
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    triggers,
    materiality,
    emailEnabled,
    emailAddress,
    emailCadence,
    smsEnabled,
    smsPhone,
    smsVerified,
    smsCadence,
    quietStart,
    quietEnd,
  ]);

  const toggleIssue = (a: string) =>
    setIssues((s) => {
      const n = new Set(s);
      n.has(a) ? n.delete(a) : n.add(a);
      return n;
    });
  const patchTag = (i: number, t: WatchlistTag) =>
    setTags((arr) => arr.map((x, j) => (j === i ? t : x)));
  const delTag = (i: number) => {
    setTags((arr) => arr.filter((_, j) => j !== i));
    setOpenTags((s) => {
      const n = new Set<number>();
      s.forEach((idx) => {
        if (idx < i) n.add(idx);
        else if (idx > i) n.add(idx - 1);
      });
      return n;
    });
  };
  const addTag = () => {
    setTags((arr) => [
      ...arr,
      {
        tag: '',
        priority: 'med',
        position: 'monitor',
        synonyms: [],
        relatedEntities: [],
        riskTerms: [],
        typedTerms: [],
      },
    ]);
    setOpenTags((s) => new Set(s).add(tags.length));
  };
  const toggleOpen = (i: number) =>
    setOpenTags((s) => {
      const n = new Set(s);
      n.has(i) ? n.delete(i) : n.add(i);
      return n;
    });
  const toggleTrig = (k: string) =>
    setTriggers((s) => {
      const n = new Set(s);
      n.has(k) ? n.delete(k) : n.add(k);
      return n;
    });

  // Seed from profile: merge capability tags + sector-derived issue areas into
  // the form (dedup by tag name); autosave persists. Reviewable, never silent.
  const seedCount = (seed?.tags.length ?? 0) + (seed?.issueAreas.length ?? 0);
  const importFromProfile = () => {
    if (!seed) return;
    if (seed.issueAreas.length) {
      setIssues((s) => {
        const n = new Set(s);
        seed.issueAreas.forEach((a) => n.add(a));
        return n;
      });
    }
    if (seed.tags.length) {
      setTags((arr) => {
        const have = new Set(arr.map((t) => t.tag.toLowerCase()));
        const add = seed.tags
          .filter((t) => !have.has(t.tag.toLowerCase()))
          .map((t) => ({
            ...t,
            synonyms: [...t.synonyms],
            relatedEntities: [...t.relatedEntities],
            riskTerms: [...t.riskTerms],
            typedTerms: (t.typedTerms ?? []).map((x) => ({ ...x })),
          }));
        return [...arr, ...add];
      });
    }
    // The debounced autosave persists the merge; saveWatchlistMutation.onSuccess
    // then refreshes the seed suggestions (so the banner clears post-save).
  };

  // P6: sector-derived issue-area suggestion for a never-configured client
  // (returned by getWatchlist without being persisted). Hide any the user has
  // already selected so the prompt only shows what's still un-added.
  const suggestedAreas = (watchlist.suggestedIssueAreas ?? []).filter((a) => !issues.has(a));

  const verifySms = () => onRequestVerify(smsPhone, () => setSmsVerified(true));
  const testChannels = () => {
    const ch: ('email' | 'sms' | 'in_app')[] = ['in_app'];
    if (emailEnabled) ch.push('email');
    if (smsEnabled && smsVerified) ch.push('sms');
    onTestAlert(ch);
  };

  return (
    <div className="cfg">
      {/* Targeting */}
      <div className="surface">
        <div className="surface-head">
          <h3>Targeting</h3>
          <span className="sub">what Capiro watches for this client</span>
          <span className="save">
            <Icon name="check" size={13} /> Saved
          </span>
        </div>
        <div className="cfg-body">
          {seedCount > 0 && (
            <div className="cfg-seed">
              <span className="cfg-seed-txt">
                Seed from this client's profile —{' '}
                {seed!.tags.length > 0 && (
                  <b>
                    {seed!.tags.length} capability tag{seed!.tags.length === 1 ? '' : 's'}
                  </b>
                )}
                {seed!.tags.length > 0 && seed!.issueAreas.length > 0 && ' + '}
                {seed!.issueAreas.length > 0 && (
                  <b>
                    {seed!.issueAreas.length} issue area{seed!.issueAreas.length === 1 ? '' : 's'}
                  </b>
                )}
                .
              </span>
              <button className="btn-seed" onClick={importFromProfile}>
                <Icon name="plus" size={13} /> Import
              </button>
            </div>
          )}
          <div className="cfg-block">
            <div className="cfg-label">Issue areas</div>
            {/* P6 sector-default: a never-configured client carries the
                sector-derived issue area as a suggestion. Surface it as a
                one-click pre-selection so cold clients aren't blank — the user
                opts in (no silent write on read). */}
            {suggestedAreas.length > 0 && (
              <div className="cfg-suggest">
                <span className="cfg-suggest-txt">
                  Suggested from this client's sector:{' '}
                  {suggestedAreas.map((a) => (
                    <button key={a} className="suggest-chip" onClick={() => toggleIssue(a)}>
                      <Icon name="plus" size={11} /> {a}
                    </button>
                  ))}
                </span>
              </div>
            )}
            <div className="issue-row">
              {allIssueAreas.map((a) => (
                <button
                  key={a}
                  className={`issue-chip${issues.has(a) ? ' on' : ''}`}
                  onClick={() => toggleIssue(a)}
                >
                  <span className="ic">
                    <Icon name="check" size={12} />
                  </span>
                  {a}
                </button>
              ))}
            </div>
            <div className="cfg-help">
              Capiro-managed taxonomy. Selected areas seed the recommendation matcher and alert
              routing.
            </div>
          </div>

          <div className="cfg-block" style={{ marginTop: 22 }}>
            <div className="cfg-label">Client tags &amp; watchlist</div>
            {/* LegiWatch v2 (L4): explain priority vs position inline (Gherkin U6). */}
            <div className="cfg-help" style={{ marginTop: 2, marginBottom: 10 }}>
              Each tag carries a <b>priority</b> (how much it matters — this drives how alerts are
              ranked) and a <b>position</b> (this client’s stance: Support, Oppose, or Monitor).
              Click either pill to change it.
            </div>
            <div className="tag-list">
              {tags.map((t, i) => (
                <TagRow
                  key={i}
                  tag={t}
                  open={openTags.has(i)}
                  onToggleOpen={() => toggleOpen(i)}
                  onChange={(nt) => patchTag(i, nt)}
                  onDelete={() => delTag(i)}
                  typedTermsEnabled={typedTermsEnabled}
                />
              ))}
            </div>
            <button className="add-tag-btn" onClick={addTag}>
              <Icon name="plus" size={13} /> Add tag
            </button>
            <div className="cfg-help" style={{ marginTop: 10 }}>
              Synonyms, related entities, and risk terms tune the embeddings + keyword match behind
              Recommendations.
            </div>
          </div>
        </div>
      </div>

      {/* Alerts */}
      <div className="surface">
        <div className="surface-head">
          {/* LegiWatch v2 (L4/U6): per-user, per-client — titled "Your alerts for
              [client]" (keyed userId+clientId). The old "this team" copy read
              firm-wide and was wrong (Q6). */}
          <h3>{clientName ? `Your alerts for ${clientName}` : 'Your alerts'}</h3>
          <span className="sub">per-user — only you get these, not the whole team</span>
          <span className="save">
            <Icon name="check" size={13} /> Saved
          </span>
        </div>
        <div className="cfg-body">
          <div className="cfg-block">
            <div className="cfg-label">Alert triggers</div>
            <div className="trig-grid">
              {TRIGGER_ORDER.map((k) => (
                <div
                  key={k}
                  className={`trig${triggers.has(k) ? ' on' : ''}`}
                  onClick={() => toggleTrig(k)}
                >
                  <span className="cbx">
                    <span className="ck">
                      <Icon name="check" size={12} />
                    </span>
                  </span>
                  {TRIGGER_LABELS[k]}
                </div>
              ))}
            </div>
          </div>

          <div className="cfg-block" style={{ marginTop: 22 }}>
            <div className="cfg-label">Materiality threshold</div>
            <div className="mat-seg">
              {(['low', 'medium', 'high'] as const).map((m) => (
                <button
                  key={m}
                  className={materiality === m ? 'on' : ''}
                  onClick={() => setMateriality(m)}
                >
                  {m.charAt(0).toUpperCase() + m.slice(1)}
                </button>
              ))}
            </div>
            <div className="cfg-help">
              Only alert me when the change is at least this important. Suppresses trivial metadata
              churn.
            </div>
          </div>

          <div className="cfg-block" style={{ marginTop: 22 }}>
            <div className="cfg-label">Channels</div>
            <div className="chan-list">
              {/* in-app */}
              <div className="chan">
                <div className="chan-top">
                  <span className="chan-ico">
                    <Icon name="bell" size={17} />
                  </span>
                  <div style={{ flex: 1 }}>
                    <div className="chan-name">In-app</div>
                    <div className="chan-sub">Changes inbox + unread dots on board cards</div>
                  </div>
                  <span className="chan-lock">Always on</span>
                  <button className="tgl locked on" title="Always on" disabled />
                </div>
              </div>

              {/* email */}
              <div className="chan">
                <div className="chan-top">
                  <span className="chan-ico">
                    <Icon name="mail" size={17} />
                  </span>
                  <div style={{ flex: 1 }}>
                    <div className="chan-name">Email</div>
                    <div className="chan-sub">Full context — bill, change, why it matters</div>
                  </div>
                  <button
                    className={`tgl${emailEnabled ? ' on' : ''}`}
                    onClick={() => setEmailEnabled((v) => !v)}
                  />
                </div>
                {emailEnabled && (
                  <div className="chan-body">
                    <div className="field">
                      <Icon name="mail" size={13} style={{ color: 'var(--ink-3)' }} />
                      <input
                        value={emailAddress}
                        placeholder="you@firm.com"
                        onChange={(e) => setEmailAddress(e.target.value)}
                      />
                    </div>
                    <CadenceSeg
                      value={emailCadence}
                      onChange={setEmailCadence}
                      opts={[
                        { v: 'realtime', l: 'Real-time' },
                        { v: 'daily', l: 'Daily digest' },
                        { v: 'weekly', l: 'Weekly digest' },
                      ]}
                    />
                  </div>
                )}
              </div>

              {/* sms */}
              <div className="chan urgent">
                <div className="chan-top">
                  <span className="chan-ico">
                    <Icon name="phone" size={17} />
                  </span>
                  <div style={{ flex: 1 }}>
                    <div className="chan-name">
                      SMS <span className="urgent-hint">Coming soon</span>
                    </div>
                    <div className="chan-sub">
                      Out of scope this round — email is the live channel today.
                    </div>
                  </div>
                  {/* LegiWatch v2 (L4/U6/D12): SMS is "coming soon" — disabled so it
                      can't be newly enabled; the verify/cadence flow stays in code. */}
                  <button
                    className={`tgl${smsEnabled ? ' on' : ''}`}
                    disabled
                    title="SMS delivery is coming soon"
                    style={{ cursor: 'not-allowed', opacity: 0.5 }}
                    onClick={() => setSmsEnabled((v) => !v)}
                  />
                </div>
                {smsEnabled && (
                  <>
                    <div className="chan-body">
                      <div className="field mono">
                        <input
                          className="mono"
                          value={smsPhone}
                          placeholder="+1 (415) 555-1234"
                          onChange={(e) => {
                            setSmsPhone(e.target.value);
                            setSmsVerified(false);
                          }}
                        />
                        {smsVerified && (
                          <span className="verified" style={{ marginLeft: 'auto' }}>
                            <Icon name="check" size={13} /> Verified
                          </span>
                        )}
                      </div>
                      {smsVerified ? (
                        <button className="btn sm" onClick={verifySms}>
                          Re-verify
                        </button>
                      ) : (
                        <button className="btn-verify" onClick={verifySms}>
                          Verify
                        </button>
                      )}
                    </div>
                    <div
                      className="chan-body"
                      style={{ borderTop: 'none', paddingTop: 0, marginTop: 0 }}
                    >
                      <CadenceSeg
                        value={smsCadence}
                        onChange={setSmsCadence}
                        opts={[
                          { v: 'realtime', l: 'Real-time' },
                          { v: 'daily', l: 'Daily digest' },
                        ]}
                      />
                      <div className="quiet-row">
                        <Icon name="clock" size={13} style={{ color: 'var(--ink-3)' }} />
                        Quiet hours
                        <input
                          className="qh"
                          style={{ width: 64 }}
                          value={quietStart}
                          onChange={(e) => setQuietStart(e.target.value)}
                        />
                        –
                        <input
                          className="qh"
                          style={{ width: 64 }}
                          value={quietEnd}
                          onChange={(e) => setQuietEnd(e.target.value)}
                        />
                      </div>
                    </div>
                  </>
                )}
              </div>
            </div>

            <div className="cfg-test">
              <button className="btn" onClick={testChannels}>
                <Icon name="send" size={13} /> Send test alert
              </button>
              <span className="note">
                Fires a sample alert to every enabled channel so you can confirm wiring.
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
