/**
 * Hill Day Wizard — /workspace/documents/new.
 *
 * Six steps, exactly the prototype's FLOW section: Template, Sponsor,
 * Meetings, Resolution, Context, Generate. Forward navigation is always
 * allowed (a step with unresolved input warns and proceeds); the rail permits
 * jumping back to any completed step without losing later input; the sticky
 * footer carries the forward contract. Every read and write goes through the
 * workspace engine's Hill Day API (api.ts) — nothing here is fixture-backed.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@clerk/clerk-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { config } from '../../../../env.js';
import { HILL_DAY_BLUEPRINT_ID, streamJobEvents, useHillDayApi, type HillDayClient } from './api.js';
import { DirectoryBrowser } from './DirectoryBrowser.js';
import { DAY_LABELS, DOW_LABELS, LOOKBACK_OPTIONS, SPONSOR_SUPPLIES } from './fixtures.js';
import {
  DEFAULT_TIME_ZONE,
  addDays,
  dayNumber,
  fmtDuration,
  fmtTime,
  fmtWeekRange,
  localDateKey,
  localTimeKey,
  mondayOf,
  zonedInstantUtc,
  zonedMidnightUtc,
} from './hillday-time.js';
import type {
  AttendeeState,
  CalendarEvent,
  CarrySelection,
  CarryUnit,
  CorrectionBody,
  DirectoryBrowseContact,
  DocumentResolution,
  JobEvent,
  JobUnit,
  MeetingResolution,
  ResolvedAttendee,
  SourceStatusBlock,
  ThreadRef,
} from './types.js';
import { blueprintIcon } from './types.js';
import { HdIcon, HdPill, HdPrimary, HdSecondary, type HillDayIcon } from './ui.js';

const STEP_LABELS = ['Template', 'Sponsor', 'Meetings', 'Resolution', 'Context', 'Generate'];
const TZ = DEFAULT_TIME_ZONE;

interface LocalContext {
  note: string;
  carry: CarrySelection;
  threadIds: string[];
  dirty: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function effectiveCarry(units: CarryUnit[]): CarrySelection {
  return {
    committees: units.some((u) => u.kind === 'committees' && u.selected),
    bio: units.some((u) => u.kind === 'bio' && u.selected),
    issueAreas: units.filter((u) => u.kind === 'issue_area' && u.selected).map((u) => u.id),
    staffers: units.filter((u) => u.kind === 'staffer' && u.selected).map((u) => u.id.replace(/^staffer:/, '')),
  };
}

function errorMessage(err: unknown): string {
  const e = err as { response?: { data?: { message?: string | string[] } }; message?: string };
  const m = e.response?.data?.message;
  if (Array.isArray(m)) return m.join(' ');
  return m ?? e.message ?? 'Something went wrong';
}

function degradedSources(blocks: SourceStatusBlock[] | undefined): SourceStatusBlock[] {
  return (blocks ?? []).filter((b) => b.status !== 'ok');
}

const STATE_META: Record<AttendeeState, { label: string; ok: boolean; icon: HillDayIcon }> = {
  resolved: { label: 'Resolved', ok: true, icon: 'CheckCircle' },
  unresolved: { label: 'No Directory match', ok: false, icon: 'HelpCircle' },
  scheduler: { label: 'Scheduler only', ok: false, icon: 'ClockRewind' },
  stale: { label: 'Office may be stale', ok: false, icon: 'ClockRewind' },
};

export function HillDayWizard() {
  const navigate = useNavigate();
  const api = useHillDayApi();
  const queryClient = useQueryClient();
  const { getToken } = useAuth();

  const [step, setStep] = useState(0);
  const [maxStep, setMaxStep] = useState(0);
  const [narrow, setNarrow] = useState(false);
  const [view, setView] = useState<'cal' | 'list' | 'directory'>('cal');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // Sponsor + document
  const [clientSearch, setClientSearch] = useState('');
  const [clientId, setClientId] = useState<string | null>(null);
  const [docName, setDocName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [docId, setDocId] = useState<string | null>(null);
  const [docClientId, setDocClientId] = useState<string | null>(null);
  const savedNameRef = useRef<string>('');

  // Meetings
  const [weekStart, setWeekStart] = useState(() => mondayOf(new Date(), TZ));
  const [jumped, setJumped] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [decided, setDecided] = useState<Set<string>>(() => new Set());
  const [seenWeeks, setSeenWeeks] = useState<Set<string>>(() => new Set());
  const [eventIndex, setEventIndex] = useState<Record<string, CalendarEvent>>({});
  // Meetings picked from step 3's Directory tab — no calendar event backs
  // them. Client-side only until commit, same as `selected` for calendar
  // events; committed via a separate addManualMeeting() call per pick.
  const [manualMeetings, setManualMeetings] = useState<
    Array<{ tempId: string; memberId: string; label: string; subline: string }>
  >([]);

  // Context
  const [ctxId, setCtxId] = useState<string | null>(null);
  const [lookback, setLookback] = useState(90);
  const [ctxLocal, setCtxLocal] = useState<Record<string, LocalContext>>({});

  // Generation
  const [jobId, setJobId] = useState<string | null>(null);
  const [units, setUnits] = useState<JobUnit[]>([]);
  const [jobDone, setJobDone] = useState<{ sections: number; failed: number; quality: number } | null>(null);
  const [jobFailed, setJobFailed] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth < 1319);
    onResize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  useEffect(() => () => abortRef.current?.abort(), []);

  // ── Queries ────────────────────────────────────────────────────────────────
  const blueprintsQuery = useQuery({
    queryKey: ['hd', 'blueprints'],
    queryFn: () => api.listBlueprints(),
    staleTime: 60_000,
  });
  const clientsQuery = useQuery({
    queryKey: ['hd', 'clients', clientSearch],
    queryFn: () => api.listClients(clientSearch || undefined),
    staleTime: 30_000,
  });
  const clients = clientsQuery.data?.items ?? [];
  const client = clients.find((c) => c.id === clientId) ?? null;
  const clientName = client?.name ?? null;

  const from = zonedMidnightUtc(weekStart, TZ);
  const to = zonedMidnightUtc(addDays(weekStart, 7), TZ);
  const calendarQuery = useQuery({
    queryKey: ['hd', 'calendar', clientId, weekStart],
    queryFn: () => api.calendar(clientId!, from, to, TZ),
    enabled: Boolean(clientId) && step === 2,
    staleTime: 30_000,
  });

  const resolutionKey = ['hd', 'resolution', docId] as const;
  const resolutionQuery = useQuery({
    queryKey: resolutionKey,
    queryFn: () => api.getResolution(docId!),
    enabled: Boolean(docId) && step >= 3,
    staleTime: Infinity,
  });
  const resolution = resolutionQuery.data ?? null;
  const meetings = useMemo(() => resolution?.meetings ?? [], [resolution]);
  const ctxMeetingId = ctxId && meetings.some((m) => m.meetingId === ctxId) ? ctxId : meetings[0]?.meetingId ?? null;

  const ctxQuery = useQuery({
    queryKey: ['hd', 'context', docId, ctxMeetingId, lookback],
    queryFn: () => api.getContext(docId!, ctxMeetingId!, lookback),
    enabled: step === 4 && Boolean(docId) && Boolean(ctxMeetingId),
    staleTime: 30_000,
  });

  // ── Effects ────────────────────────────────────────────────────────────────
  // Name prefills from the sponsor and stays editable.
  useEffect(() => {
    if (clientName && !nameTouched) setDocName(`${clientName} Hill Day Schedule`);
  }, [clientName, nameTouched]);

  // Calendar: jump to the sponsor's next tagged week once, then default-select
  // hill meetings the first time a week is shown (internal stays unselected).
  useEffect(() => {
    const data = calendarQuery.data;
    if (!data) return;
    setEventIndex((prev) => {
      const next = { ...prev };
      for (const e of data.events) next[e.eventId] = e;
      return next;
    });
    if (!jumped) {
      setJumped(true);
      if (!data.events.length && data.upcomingEventAt) {
        setWeekStart(mondayOf(data.upcomingEventAt, TZ));
        return;
      }
    }
    if (!seenWeeks.has(weekStart)) {
      setSeenWeeks((prev) => new Set(prev).add(weekStart));
      setSelected((prev) => {
        const next = new Set(prev);
        for (const e of data.events) if (e.kind === 'hill' && !decided.has(e.eventId)) next.add(e.eventId);
        return [...next];
      });
    }
  }, [calendarQuery.data, jumped, seenWeeks, weekStart, decided]);

  // Context: initialise local state from the server record or its defaults.
  useEffect(() => {
    const data = ctxQuery.data;
    if (!data || !ctxMeetingId || ctxLocal[ctxMeetingId]) return;
    setCtxLocal((prev) => ({
      ...prev,
      [ctxMeetingId]: {
        note: data.record?.note ?? '',
        carry: effectiveCarry(data.units),
        threadIds: data.record?.threadIds ?? [],
        dirty: false,
      },
    }));
  }, [ctxQuery.data, ctxMeetingId, ctxLocal]);

  // Context: debounced save of what the user chose — the authoritative record.
  useEffect(() => {
    const id = ctxMeetingId;
    const local = id ? ctxLocal[id] : undefined;
    if (!docId || !id || !local?.dirty) return;
    const timer = setTimeout(async () => {
      try {
        await api.putContext(docId, id, {
          note: local.note,
          carry: local.carry,
          threadIds: local.threadIds,
          lookbackDays: lookback,
        });
        setCtxLocal((prev) => (prev[id] ? { ...prev, [id]: { ...prev[id]!, dirty: false } } : prev));
      } catch (err) {
        setError(`Context could not be saved: ${errorMessage(err)}`);
      }
    }, 600);
    return () => clearTimeout(timer);
  }, [ctxLocal, ctxMeetingId, docId, lookback, api]);

  // ── Actions ────────────────────────────────────────────────────────────────
  const goTo = useCallback((s: number) => {
    const clamped = Math.max(0, Math.min(5, s));
    setStep(clamped);
    setMaxStep((m) => Math.max(m, clamped));
    setError(null);
  }, []);

  const pickClient = (id: string) => {
    if (id !== clientId) {
      setClientId(id);
      setJumped(false);
      setSeenWeeks(new Set());
      setDecided(new Set());
      setSelected([]);
      setManualMeetings([]);
      setWeekStart(mondayOf(new Date(), TZ));
    }
  };

  async function ensureDocument(): Promise<string> {
    if (!clientId) throw new Error('Choose a sponsoring client first');
    const name = docName.trim() || `${clientName ?? 'Client'} Hill Day Schedule`;
    if (docId && docClientId === clientId) {
      if (savedNameRef.current !== name) {
        await api.patchDocument(docId, { name });
        savedNameRef.current = name;
      }
      return docId;
    }
    const created = await api.createDocument({
      blueprintId: HILL_DAY_BLUEPRINT_ID,
      clientId,
      name,
      lookbackDays: lookback,
      timeZone: TZ,
    });
    savedNameRef.current = name;
    setDocId(created.id);
    setDocClientId(clientId);
    setCtxLocal({});
    setJobId(null);
    setUnits([]);
    setJobDone(null);
    return created.id;
  }

  async function commitMeetingsAndResolve(): Promise<void> {
    const id = await ensureDocument();
    await api.setMeetings(id, { eventIds: selected, weekStart, timeZone: TZ });
    // One addManualMeeting() call per Directory pick, in parallel — mirrors
    // flushContext()'s pattern. Each call is idempotent by member on the
    // server, so a retry after a partial failure here can't create
    // duplicates; manualMeetings is only cleared once every call succeeds.
    if (manualMeetings.length) {
      await Promise.all(
        manualMeetings.map(async (mm) => {
          const { event: created } = await api.addManualMeeting(id, mm.memberId);
          setEventIndex((prev) => ({ ...prev, [created.eventId]: created }));
        }),
      );
      setManualMeetings([]);
    }
    const result = await api.runResolution(id);
    queryClient.setQueryData(resolutionKey, result);
    await queryClient.invalidateQueries({ queryKey: ['hd', 'context', id] });
    setCtxLocal({});
    setCtxId(result.meetings[0]?.meetingId ?? null);
  }

  async function flushContext(id: string): Promise<void> {
    const dirty = Object.entries(ctxLocal).filter(([, v]) => v.dirty);
    await Promise.all(
      dirty.map(([meetingId, v]) =>
        api.putContext(id, meetingId, { note: v.note, carry: v.carry, threadIds: v.threadIds, lookbackDays: lookback }),
      ),
    );
    if (dirty.length) {
      setCtxLocal((prev) => {
        const next = { ...prev };
        for (const [k, v] of Object.entries(next)) next[k] = { ...v, dirty: false };
        return next;
      });
    }
  }

  const applyUnit = (data: Record<string, unknown>) => {
    const meetingId = String(data.meetingId ?? '');
    setUnits((prev) =>
      prev.map((u) =>
        u.meetingId === meetingId
          ? { ...u, state: (data.state as JobUnit['state']) ?? u.state, reason: (data.reason as string | null) ?? null }
          : u,
      ),
    );
  };

  async function pollJob(id: string, job: string, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const status = await api.jobStatus(id, job);
      setUnits(status.units);
      if (status.status === 'complete') {
        setJobDone({
          sections: status.units.length,
          failed: status.units.filter((u) => u.state === 'failed').length,
          quality: status.quality ?? 0,
        });
        return;
      }
      if (status.status === 'failed') {
        setJobFailed(status.error ?? 'Generation failed');
        return;
      }
      await sleep(2000);
    }
  }

  async function startGeneration(id: string): Promise<void> {
    setJobDone(null);
    setJobFailed(null);
    setUnits(meetings.map((m) => ({ meetingId: m.meetingId, state: 'queued', sectionId: m.meetingId, reason: null, at: '' })));
    const { jobId: job } = await api.generate(id);
    setJobId(job);
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const onEvent = (ev: JobEvent) => {
      if (ev.event === 'unit') applyUnit(ev.data);
      else if (ev.event === 'complete') {
        setJobDone({
          sections: Number(ev.data.sections ?? 0),
          failed: Number(ev.data.failed ?? 0),
          quality: Number(ev.data.quality ?? 0),
        });
      } else if (ev.event === 'failed') setJobFailed(String(ev.data.reason ?? 'Generation failed'));
    };
    let outcome: 'complete' | 'failed' | 'closed' = 'closed';
    try {
      outcome = await streamJobEvents({
        apiBaseUrl: config.apiBaseUrl,
        getToken: () => getToken({ template: 'capiro' }),
        docId: id,
        jobId: job,
        after: 0,
        onEvent,
        signal: ctrl.signal,
      });
    } catch {
      outcome = 'closed';
    }
    // Poll fallback at the same path without /events, every 2s.
    if (outcome === 'closed' && !ctrl.signal.aborted) await pollJob(id, job, ctrl.signal);
  }

  const next = async () => {
    setError(null);
    try {
      if (step === 0) {
        goTo(1);
      } else if (step === 1) {
        if (!clientId) {
          setError('Choose the sponsoring client to continue.');
          return;
        }
        setBusy('Creating document…');
        await ensureDocument();
        goTo(2);
      } else if (step === 2) {
        if (!selected.length && !manualMeetings.length) {
          setError('Select at least one meeting — the packet needs something to write about.');
          return;
        }
        setBusy('Resolving attendees…');
        await commitMeetingsAndResolve();
        goTo(3);
      } else if (step === 3) {
        goTo(4);
      } else if (step === 4) {
        if (!docId) return;
        setBusy('Saving context…');
        await flushContext(docId);
        goTo(5);
        setBusy(null);
        await startGeneration(docId);
      } else if (step === 5) {
        if (jobDone && docId) navigate(`/workspace/documents/${docId}`, { replace: true });
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const applyCorrection = async (meetingId: string, body: CorrectionBody) => {
    if (!docId) return;
    setError(null);
    try {
      const { resolution: updated, event: updatedEvent } = await api.correct(docId, meetingId, body);
      queryClient.setQueryData<DocumentResolution>(resolutionKey, (prev) => {
        if (!prev) return prev;
        const nextMeetings = prev.meetings.map((m) => (m.meetingId === meetingId ? updated : m));
        return {
          ...prev,
          meetings: nextMeetings,
          status: nextMeetings.every((m) => m.state === 'clean') ? 'clean' : 'partial',
        };
      });
      // Refresh the local event cache too — required for edit_meeting_facts
      // (time/subject/location just changed) and harmless for the other kinds.
      setEventIndex((prev) => ({ ...prev, [updatedEvent.eventId]: updatedEvent }));
      await queryClient.invalidateQueries({ queryKey: ['hd', 'context', docId, meetingId] });
      setCtxLocal((prev) => {
        if (!prev[meetingId]) return prev;
        const nextLocal = { ...prev };
        delete nextLocal[meetingId];
        return nextLocal;
      });
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const updateLocal = (meetingId: string, patch: Partial<Omit<LocalContext, 'dirty'>>) =>
    setCtxLocal((prev) => {
      const cur = prev[meetingId];
      if (!cur) return prev;
      return { ...prev, [meetingId]: { ...cur, ...patch, dirty: true } };
    });

  // ── Derived ────────────────────────────────────────────────────────────────
  const weekEvents = calendarQuery.data?.events ?? [];
  const weekDays = useMemo(() => {
    const byDay = new Map<string, CalendarEvent[]>();
    for (let i = 0; i < 7; i += 1) byDay.set(addDays(weekStart, i), []);
    for (const e of weekEvents) {
      const key = localDateKey(e.startsAt, calendarQuery.data?.timeZone ?? TZ);
      if (!byDay.has(key)) byDay.set(key, []);
      byDay.get(key)!.push(e);
    }
    const hillCounts = [...byDay.entries()].map(([k, list]) => [k, list.filter((e) => e.kind === 'hill').length] as const);
    const hillDay = hillCounts.reduce<[string, number] | null>((best, cur) => (cur[1] > 0 && (!best || cur[1] > best[1]) ? [cur[0], cur[1]] : best), null);
    return Array.from({ length: 7 }, (_, i) => {
      const key = addDays(weekStart, i);
      const items = (byDay.get(key) ?? []).sort((a, b) => a.startsAt.localeCompare(b.startsAt));
      return { key, index: i, items, hill: hillDay?.[0] === key };
    }).filter((d) => d.index < 5 || d.items.length > 0);
  }, [weekEvents, weekStart, calendarQuery.data?.timeZone]);
  const tz = calendarQuery.data?.timeZone ?? TZ;
  const selectedInWeek = weekEvents.filter((e) => selected.includes(e.eventId)).length;
  const selectedElsewhere = selected.length - selectedInWeek;
  const totalSelected = selected.length + manualMeetings.length;

  // Members already on the document (committed manual meetings) or queued to
  // be added on the next commit — the Directory tab marks both as "Added".
  const committedMemberIds = useMemo(
    () =>
      new Set(
        meetings
          .filter((m) => m.office.derivedFrom === 'manual_selection' && m.office.memberId)
          .map((m) => m.office.memberId!),
      ),
    [meetings],
  );
  const pickedMemberIds = useMemo(
    () => new Set([...committedMemberIds, ...manualMeetings.map((mm) => mm.memberId)]),
    [committedMemberIds, manualMeetings],
  );

  const pickFromDirectory = (contact: DirectoryBrowseContact) => {
    if (pickedMemberIds.has(contact.id)) return;
    const stateChamber = [contact.chamber, contact.state].filter(Boolean).join(' · ');
    setManualMeetings((prev) => [
      ...prev,
      {
        tempId: `pending-${contact.id}`,
        memberId: contact.id,
        label: `${contact.honorific ? `${contact.honorific} ` : ''}${contact.fullName}`.trim(),
        subline: [stateChamber, contact.committees[0]].filter(Boolean).join(' · '),
      },
    ]);
  };
  const removePendingPick = (memberId: string) =>
    setManualMeetings((prev) => prev.filter((mm) => mm.memberId !== memberId));

  const toggle = (id: string) => {
    setDecided((prev) => new Set(prev).add(id));
    setSelected((arr) => (arr.includes(id) ? arr.filter((x) => x !== id) : [...arr, id]));
  };

  const gaps = meetings.reduce((n, m) => n + m.attendees.filter((a) => a.state !== 'resolved').length, 0);
  const totalAtt = meetings.reduce((n, m) => n + m.attendees.length, 0);
  const ctxMeeting = meetings.find((m) => m.meetingId === ctxMeetingId) ?? null;
  const ctxData = ctxQuery.data && ctxQuery.data.meetingId === ctxMeetingId ? ctxQuery.data : null;
  const local = ctxMeetingId ? ctxLocal[ctxMeetingId] : undefined;
  const unitOn = (u: CarryUnit): boolean => {
    if (!local) return u.selected;
    switch (u.kind) {
      case 'committees':
        return local.carry.committees;
      case 'bio':
        return local.carry.bio;
      case 'issue_area':
        return local.carry.issueAreas.includes(u.id);
      case 'staffer':
        return local.carry.staffers.includes(u.id.replace(/^staffer:/, ''));
      default:
        return u.selected;
    }
  };
  const toggleUnit = (u: CarryUnit) => {
    if (!ctxMeetingId || !local) return;
    const on = unitOn(u);
    const carry = { ...local.carry, issueAreas: [...local.carry.issueAreas], staffers: [...local.carry.staffers] };
    if (u.kind === 'committees') carry.committees = !on;
    else if (u.kind === 'bio') carry.bio = !on;
    else if (u.kind === 'issue_area') carry.issueAreas = on ? carry.issueAreas.filter((x) => x !== u.id) : [...carry.issueAreas, u.id];
    else {
      const id = u.id.replace(/^staffer:/, '');
      carry.staffers = on ? carry.staffers.filter((x) => x !== id) : [...carry.staffers, id];
    }
    updateLocal(ctxMeetingId, { carry });
  };
  const carryUnits = ctxData?.units ?? [];
  const carryTotal = carryUnits.length;
  const carryUsed = carryUnits.filter((u) => unitOn(u)).length;

  const totalUnits = units.length;
  const finished = units.filter((u) => u.state === 'done' || u.state === 'failed').length;
  const pct = totalUnits ? Math.round((finished / totalUnits) * 100) : 0;
  const runDone = Boolean(jobDone) || Boolean(jobFailed);

  const footers = [
    'Blueprint decides the questions and the sections.',
    'Calendar and objectives come from the sponsor.',
    `${totalSelected} meeting${totalSelected === 1 ? '' : 's'} selected${
      manualMeetings.length ? ` (${manualMeetings.length} from the Directory)` : ''
    } · ${totalSelected} prep section${totalSelected === 1 ? '' : 's'} will be written.`,
    gaps
      ? `${gaps} of ${totalAtt} attendees still need input. You can generate anyway.`
      : `${totalAtt} attendees resolved.`,
    `Context is optional. Threads outside ${lookback} days are excluded.`,
    jobFailed
      ? `Generation failed: ${jobFailed}. Go back and try again.`
      : jobDone
        ? `${jobDone.sections - jobDone.failed} of ${jobDone.sections} prep sections drafted. Nothing is applied until you open the document.`
        : 'Meri is drafting. You can leave and come back.',
  ];
  const nextLabels = [
    'Continue',
    'Open calendar',
    'Resolve attendees',
    'Add context',
    'Generate packet',
    jobDone ? 'Open document' : jobFailed ? 'Generation failed' : 'Generating…',
  ];
  const nextDisabled = Boolean(busy) || (step === 5 && !jobDone);

  return (
    <div className="hd-root" style={{ display: 'flex', flexDirection: 'column', minHeight: '100%', background: 'var(--hd-canvas)' }}>
    <div className="hd-flow">
      {/* Sticky top bar with the step rail */}
      <div className="hd-flow__topbar">
        <button type="button" className="hd-icon-btn" onClick={() => navigate('/workspace/documents')} aria-label="Back to documents">
          <HdIcon name="FlipBackward" size={18} />
        </button>
        <span className="hd-flow__crumb">
          <span className="hd-flow__crumb-title">New document</span>
          <span className="hd-flow__crumb-sub">Hill Day Schedule · {clientName ?? 'Choose a sponsor'}</span>
        </span>
        <span className="hd-flow__compact-chip">
          Step {step + 1} of 6 · {STEP_LABELS[step]}
        </span>
        <div className={`hd-flow__rail${narrow ? ' hd-flow__rail--hidden' : ''}`}>
          {STEP_LABELS.map((label, i) => (
            <button
              key={label}
              type="button"
              className={[
                'hd-step',
                i === step ? 'hd-step--current' : '',
                i < step ? 'hd-step--past' : '',
                i > maxStep ? 'hd-step--skipped' : '',
              ].join(' ')}
              onClick={() => i <= maxStep && !busy && i !== 5 && goTo(i)}
              aria-current={i === step ? 'step' : undefined}
            >
              <span className="hd-step__num">{i + 1}</span>
              <span className="hd-step__label">{label}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="hd-flow__body">
        {error && (
          <div className="hd-resolve__banner hd-resolve__banner--warn" role="alert" style={{ marginBottom: 20 }}>
            <span className="hd-resolve__banner-icon">
              <HdIcon name="AlertTriangle" size={18} />
            </span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span className="hd-resolve__banner-title">Something needs attention</span>
              <span className="hd-resolve__banner-body">{error}</span>
            </span>
          </div>
        )}

        {/* Step 1 · Template */}
        {step === 0 && (
          <div style={{ maxWidth: 1080 }}>
            <h2 className="hd-step-heading">What are you making?</h2>
            <p className="hd-step-sub" style={{ maxWidth: '60ch' }}>
              The template decides which layers the document reads from and which questions you are
              asked before it is drafted.
            </p>
            {blueprintsQuery.isError && (
              <p className="hd-step-sub">The blueprint catalog is unavailable right now. Hill Day Schedule is still available below.</p>
            )}
            <div className="hd-pick-grid">
              {(blueprintsQuery.data ?? []).map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className={`hd-pick-card${t.implemented ? ' hd-pick-card--on' : ''}`}
                  onClick={() => (t.implemented ? goTo(1) : navigate('/workspace/new'))}
                  title={t.implemented ? undefined : 'Not implemented yet — opens the existing workspace flow'}
                >
                  <span style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
                    <span
                      className={`hd-template-card__icon${t.implemented ? '' : ' hd-template-card__icon--plain'}`}
                      style={t.implemented ? undefined : { color: 'var(--hd-gray-600)' }}
                    >
                      <HdIcon name={blueprintIcon(t.icon)} size={20} />
                    </span>
                    <span className={`hd-radio${t.implemented ? ' hd-radio--on' : ''}`}>
                      <span className="hd-radio__dot" style={{ display: t.implemented ? 'block' : 'none' }} />
                    </span>
                  </span>
                  <span style={{ display: 'block' }}>
                    <span className="hd-template-card__name">{t.name}</span>
                    <span className="hd-template-card__desc">{t.description}</span>
                  </span>
                  <span className="hd-pick-card__sources">
                    {t.sources.map((src) => (
                      <span key={src} className="hd-source-badge">
                        {src}
                      </span>
                    ))}
                  </span>
                </button>
              ))}
              {blueprintsQuery.isError && (
                <button type="button" className="hd-pick-card hd-pick-card--on" onClick={() => goTo(1)}>
                  <span style={{ display: 'block' }}>
                    <span className="hd-template-card__name">Hill Day Schedule</span>
                    <span className="hd-template-card__desc">
                      One context-rich prep section per congressional meeting, assembled from the sponsor’s calendar.
                    </span>
                  </span>
                </button>
              )}
            </div>
          </div>
        )}

        {/* Step 2 · Sponsor */}
        {step === 1 && (
          <div className="hd-sponsor-grid">
            <div>
              <h2 className="hd-step-heading">Who is the sponsor?</h2>
              <p className="hd-step-sub" style={{ maxWidth: '60ch' }}>
                The sponsoring client scopes the calendar, supplies the objectives the narrative is
                written against, and provides the logo the packet is co-branded with.
              </p>
              <div className="hd-client-list">
                <div className="hd-client-list__search">
                  <HdIcon name="SearchLg" size={18} />
                  <input
                    type="text"
                    placeholder="Search Portfolio clients…"
                    aria-label="Search clients"
                    value={clientSearch}
                    onChange={(e) => setClientSearch(e.target.value)}
                  />
                  <span className="hd-eyebrow">
                    {clientsQuery.isPending ? 'Loading…' : clientsQuery.isError ? 'Unavailable' : `${clients.length} clients`}
                  </span>
                </div>
                {clients.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    className={`hd-client-row${clientId === c.id ? ' hd-client-row--on' : ''}`}
                    onClick={() => pickClient(c.id)}
                  >
                    <span className="hd-client-row__mono">{c.mono}</span>
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span className="hd-client-row__name">{c.name}</span>
                      <span className="hd-client-row__meta">
                        {[
                          c.description && c.description.length > 96
                            ? `${c.description.slice(0, 93).trimEnd()}…`
                            : c.description,
                          c.objectiveCount === null
                            ? 'objectives unavailable'
                            : `${c.objectiveCount} objective${c.objectiveCount === 1 ? '' : 's'}`,
                          `${c.officeCount} office${c.officeCount === 1 ? '' : 's'}`,
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </span>
                    </span>
                    {clientId === c.id && (
                      <span style={{ color: 'var(--hd-brand-600)', display: 'flex' }}>
                        <HdIcon name="CheckCircle" size={20} />
                      </span>
                    )}
                  </button>
                ))}
                {!clientsQuery.isPending && clients.length === 0 && (
                  <div className="hd-client-row" style={{ cursor: 'default' }}>
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span className="hd-client-row__name">
                        {clientsQuery.isError ? 'Clients unavailable' : 'No clients match'}
                      </span>
                      <span className="hd-client-row__meta">
                        {clientsQuery.isError
                          ? 'The Portfolio could not be read. Retry in a moment.'
                          : 'Try another name, or add the client in Portfolio first.'}
                      </span>
                    </span>
                  </div>
                )}
              </div>
              <div className="hd-name-field">
                <label htmlFor="hd-doc-name">Document name</label>
                <input
                  id="hd-doc-name"
                  type="text"
                  value={docName}
                  onChange={(e) => {
                    setNameTouched(true);
                    setDocName(e.target.value);
                  }}
                />
                <span className="hd-name-field__hint">
                  Prefilled from the sponsor. Editable now and after generation.
                </span>
              </div>
            </div>
            <aside className="hd-supplies">
              <span className="hd-eyebrow" style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--hd-gray-500)' }}>
                <HdIcon name="Stars02" size={14} />
                What the sponsor supplies
              </span>
              <div className="hd-supplies__list">
                {SPONSOR_SUPPLIES.map((s) => (
                  <span key={s.title} className="hd-supplies__item">
                    <span className="hd-supplies__dot" />
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span className="hd-supplies__title">{s.title}</span>
                      <span className="hd-supplies__body">{s.body}</span>
                    </span>
                  </span>
                ))}
              </div>
            </aside>
          </div>
        )}

        {/* Step 3 · Meetings */}
        {step === 2 && (
          <div style={{ maxWidth: 1360 }}>
            <div className="hd-meetings-head">
              <div style={{ minWidth: 0 }}>
                <h2 className="hd-step-heading">Which meetings go in the packet?</h2>
                <p className="hd-step-sub" style={{ maxWidth: '70ch' }}>
                  Calendar scoped to {clientName ?? 'the sponsor'}, week of {fmtWeekRange(weekStart)}. Meetings surface when an
                  attendee address matches a Directory staffer record, or when the event is tagged
                  to the client.
                </p>
                {degradedSources(calendarQuery.data?.sources).map((s) => (
                  <p key={s.source} className="hd-step-sub" style={{ color: 'var(--hd-amber-600)' }}>
                    {s.source.replace(/^calendar:/, 'Calendar (').replace(/_/g, ' ')}
                    {s.source.startsWith('calendar:') ? ')' : ''} {s.status}
                    {s.detail ? ` — ${s.detail}` : ''}
                  </p>
                ))}
              </div>
              <div className="hd-meetings-controls">
                <div className="hd-segmented" role="group" aria-label="Week">
                  <button type="button" className="hd-segmented__item" onClick={() => setWeekStart(addDays(weekStart, -7))} aria-label="Previous week">
                    <HdIcon name="ChevronDown" size={16} className="hd-rotate-90" />
                    Prev
                  </button>
                  <button type="button" className="hd-segmented__item" onClick={() => setWeekStart(mondayOf(new Date(), TZ))}>
                    This week
                  </button>
                  <button type="button" className="hd-segmented__item" onClick={() => setWeekStart(addDays(weekStart, 7))} aria-label="Next week">
                    Next
                    <HdIcon name="ChevronDown" size={16} className="hd-rotate-270" />
                  </button>
                </div>
                <div className="hd-segmented">
                  <button
                    type="button"
                    className={`hd-segmented__item${view === 'cal' ? ' hd-segmented__item--on' : ''}`}
                    onClick={() => setView('cal')}
                  >
                    <HdIcon name="Calendar2" size={16} />
                    Calendar
                  </button>
                  <button
                    type="button"
                    className={`hd-segmented__item${view === 'list' ? ' hd-segmented__item--on' : ''}`}
                    onClick={() => setView('list')}
                  >
                    <HdIcon name="List" size={16} />
                    List
                  </button>
                  <button
                    type="button"
                    className={`hd-segmented__item${view === 'directory' ? ' hd-segmented__item--on' : ''}`}
                    onClick={() => setView('directory')}
                  >
                    <HdIcon name="Users01" size={16} />
                    Directory
                  </button>
                </div>
                <span className="hd-sel-count">
                  {view === 'directory'
                    ? `${manualMeetings.length} picked from the Directory`
                    : (
                      <>
                        {selectedInWeek} of {weekEvents.length} selected
                        {selectedElsewhere > 0 ? ` (+${selectedElsewhere} other weeks)` : ''}
                        {manualMeetings.length > 0 ? ` · ${manualMeetings.length} from the Directory` : ''}
                      </>
                    )}
                </span>
              </div>
            </div>

            {calendarQuery.isPending && <p className="hd-step-sub">Loading the week…</p>}
            {calendarQuery.isError && (
              <p className="hd-step-sub" style={{ color: 'var(--hd-amber-600)' }}>
                Calendar unavailable: {errorMessage(calendarQuery.error)}
              </p>
            )}

            {view === 'cal' && (
              <div className="hd-week">
                {weekDays.map((col) => (
                  <div key={col.key} className={`hd-week__col${col.hill ? ' hd-week__col--hill' : ''}`}>
                    <div className={`hd-week__head${col.hill ? ' hd-week__head--hill' : ''}`}>
                      <span className="hd-week__dow">{DOW_LABELS[col.index]}</span>
                      <span className="hd-week__num">{dayNumber(col.key)}</span>
                      <span className="hd-week__count">{col.items.length || '—'}</span>
                    </div>
                    <div className="hd-week__body">
                      {col.items.map((m) => {
                        const on = selected.includes(m.eventId);
                        return (
                          <button
                            key={m.eventId}
                            type="button"
                            className={`hd-cal-card${on ? ' hd-cal-card--on' : ''}`}
                            onClick={() => toggle(m.eventId)}
                            title={m.reason.detail}
                          >
                            <span className="hd-cal-card__meta">
                              <span className={`hd-checkbox${on ? ' hd-checkbox--on' : ''}`} style={{ width: 14, height: 14 }}>
                                <span
                                  className="hd-checkbox__tick"
                                  style={{ width: 7, height: 7, display: on ? 'block' : 'none' }}
                                />
                              </span>
                              <span className="hd-cal-card__time">{fmtTime(m.startsAt, tz)}</span>
                              <span className="hd-cal-card__dur">{fmtDuration(m.startsAt, m.endsAt)}</span>
                            </span>
                            <span className="hd-cal-card__short">{m.subject}</span>
                            <span className="hd-cal-card__place">
                              {m.kind === 'internal' ? 'Internal · ' : ''}
                              {m.location ?? (m.isVirtual ? 'Video call' : 'Location not set')}
                            </span>
                          </button>
                        );
                      })}
                      {col.items.length === 0 && <span className="hd-week__empty">No meetings</span>}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {view === 'list' && (
              <div className="hd-list">
                {weekDays
                  .filter((d) => d.items.length)
                  .map((d) => (
                    <div key={d.key}>
                      <div className="hd-list__group">
                        {DAY_LABELS[d.index]}, {new Date(`${d.key}T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' })}
                        {d.hill ? ' · Hill Day' : ''}
                      </div>
                      {d.items.map((m) => {
                        const on = selected.includes(m.eventId);
                        const internal = m.kind === 'internal';
                        return (
                          <button
                            key={m.eventId}
                            type="button"
                            className={`hd-list__row${on ? ' hd-list__row--on' : ''}`}
                            onClick={() => toggle(m.eventId)}
                          >
                            <span style={{ flex: '0 0 auto', display: 'flex' }}>
                              <span className={`hd-checkbox${on ? ' hd-checkbox--on' : ''}`} style={{ width: 18, height: 18, borderRadius: 5 }}>
                                <span className="hd-checkbox__tick" style={{ width: 11, height: 11, display: on ? 'block' : 'none' }} />
                              </span>
                            </span>
                            <span className="hd-list__time">{fmtTime(m.startsAt, tz)}</span>
                            <span style={{ flex: 1, minWidth: 0 }}>
                              <span className="hd-list__subject">{m.subject}</span>
                              <span className="hd-list__meta">
                                {internal
                                  ? `Internal · ${m.location ?? (m.isVirtual ? 'Video call' : 'Location not set')}`
                                  : `${m.attendees.length} attendee${m.attendees.length === 1 ? '' : 's'} · ${m.location ?? (m.isVirtual ? 'Video call' : 'Location not set')}`}
                                {' · '}
                                {m.reason.detail}
                              </span>
                            </span>
                            <span style={{ flex: '0 0 auto', display: 'flex' }}>
                              <HdPill tone={internal ? 'gray' : on ? 'navy' : 'gray'}>
                                {internal ? 'Internal' : on ? 'In packet' : 'Available'}
                              </HdPill>
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  ))}
                {!calendarQuery.isPending && weekEvents.length === 0 && (
                  <div className="hd-list__group">No meetings for {clientName ?? 'this client'} this week. Use Prev / Next to find the Hill Day week.</div>
                )}
              </div>
            )}

            {view === 'directory' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                {manualMeetings.length > 0 && (
                  <div className="hd-client-list">
                    <div className="hd-client-list__search">
                      <HdIcon name="UserCheck01" size={18} />
                      <span className="hd-eyebrow" style={{ flex: 1 }}>
                        {manualMeetings.length} picked from the Directory — date and time are set on the next step
                      </span>
                    </div>
                    {manualMeetings.map((mm) => (
                      <div key={mm.tempId} className="hd-client-row" style={{ cursor: 'default' }}>
                        <span style={{ flex: 1, minWidth: 0 }}>
                          <span className="hd-client-row__name">{mm.label}</span>
                          <span className="hd-client-row__meta">{mm.subline}</span>
                        </span>
                        <HdSecondary onClick={() => removePendingPick(mm.memberId)}>Remove</HdSecondary>
                      </div>
                    ))}
                  </div>
                )}
                <DirectoryBrowser api={api} pickedMemberIds={pickedMemberIds} onPick={pickFromDirectory} />
              </div>
            )}
          </div>
        )}

        {/* Step 4 · Resolution */}
        {step === 3 && (
          <div className="hd-resolve">
            <h2 className="hd-step-heading">Confirm what we resolved</h2>
            <p className="hd-step-sub">
              Attendee address → Directory staffer → office → member. Members are almost never on
              the invite; the member is derived from the staffer's office association, not from the
              attendee list. Your corrections govern.
            </p>
            {degradedSources(resolution?.sources).map((s) => (
              <p key={s.source} className="hd-step-sub" style={{ color: 'var(--hd-amber-600)' }}>
                {s.source} {s.status}{s.detail ? ` — ${s.detail}` : ''}
              </p>
            ))}
            <div className={`hd-resolve__banner${gaps ? ' hd-resolve__banner--warn' : ''}`}>
              <span className="hd-resolve__banner-icon">
                <HdIcon name={gaps ? 'AlertTriangle' : 'CheckCircle'} size={18} />
              </span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span className="hd-resolve__banner-title">
                  {gaps
                    ? `${totalAtt - gaps} of ${totalAtt} attendees resolved`
                    : `All ${totalAtt} attendees resolved`}
                </span>
                <span className="hd-resolve__banner-body">
                  {gaps
                    ? 'Partial resolution proceeds. Unresolved attendees are flagged here, not dropped — type a name and role, or create the Directory record.'
                    : 'Every attendee mapped to a Directory record and an office. Your overrides govern.'}
                </span>
              </span>
              {gaps > 0 && (
                <HdSecondary
                  className="hd-resolve__banner-btn"
                  onClick={() => document.querySelector('.hd-att--needs-fix')?.scrollIntoView({ behavior: 'smooth', block: 'center' })}
                >
                  Jump to first gap
                </HdSecondary>
              )}
            </div>

            {resolutionQuery.isPending && <p className="hd-step-sub">Loading resolution…</p>}
            <div className="hd-resolve-cards">
              {meetings.map((m) => (
                <ResolutionCard
                  key={m.meetingId}
                  meeting={m}
                  event={eventIndex[m.eventId]}
                  tz={tz}
                  lookback={lookback}
                  api={api}
                  onCorrect={(body) => applyCorrection(m.meetingId, body)}
                />
              ))}
            </div>
          </div>
        )}

        {/* Step 5 · Context */}
        {step === 4 && (
          <div className="hd-context">
            <h2 className="hd-step-heading">Add what we don't know</h2>
            <p className="hd-step-sub">
              Per meeting: anything you know that the platform does not, plus the correspondence you
              want the narrative written from. Threads are scoped to the resolved attendees or
              tagged to {clientName ?? 'the sponsor'}.
            </p>
            {!ctxMeeting && <p className="hd-step-sub">No meetings selected. Go back to choose meetings.</p>}
            {ctxMeeting && (
              <div className="hd-context__grid">
                <div className="hd-context__rail">
                  <div className="hd-context__rail-head hd-eyebrow">{meetings.length} meetings</div>
                  {meetings.map((m) => {
                    const on = m.meetingId === ctxMeeting.meetingId;
                    const l = ctxLocal[m.meetingId];
                    const noteLen = (l?.note ?? '').length;
                    const th = l?.threadIds.length ?? 0;
                    const badge =
                      (noteLen ? 'NOTE' : '') +
                      (noteLen && th ? ' · ' : '') +
                      (th ? `${th} ${th === 1 ? 'THREAD' : 'THREADS'}` : '') || (l ? '—' : '·');
                    const ev = eventIndex[m.eventId];
                    return (
                      <button
                        key={m.meetingId}
                        type="button"
                        className={`hd-context__rail-row${on ? ' hd-context__rail-row--on' : ''}`}
                        onClick={() => setCtxId(m.meetingId)}
                      >
                        <span style={{ flex: 1, minWidth: 0 }}>
                          <span className="hd-context__rail-time">{ev ? fmtTime(ev.startsAt, tz) : ''}</span>
                          <span className="hd-context__rail-member">{m.office.member ?? ev?.subject ?? 'Meeting'}</span>
                        </span>
                        <span className={`hd-context__rail-badge${noteLen || th ? ' hd-context__rail-badge--on' : ''}`}>
                          {badge}
                        </span>
                      </button>
                    );
                  })}
                </div>

                <div className="hd-context__main">
                  <div className="hd-carry">
                    <div className="hd-carry__head">
                      <HdIcon name="Users01" size={16} />
                      <span
                        className="hd-eyebrow"
                        style={{ flex: '1 1 auto', whiteSpace: 'nowrap', color: 'var(--hd-gray-500)' }}
                      >
                        What the record already carries
                      </span>
                      <span className="hd-carry__meta">
                        {carryUsed} of {carryTotal} details carried
                      </span>
                    </div>
                    <div className="hd-carry__body">
                      <span className="hd-carry__member-row">
                        <span className="hd-carry__member">{ctxMeeting.office.member ?? 'Office not resolved'}</span>
                        <span className="hd-carry__party">{ctxMeeting.office.partyName ?? ''}</span>
                      </span>
                      <span className="hd-carry__hint">
                        Tick what should reach the draft. Anything left unticked stays in the Directory
                        record and out of this document.
                      </span>
                      {ctxQuery.isPending && <span className="hd-carry__hint">Loading the Directory record…</span>}
                      {ctxQuery.isError && (
                        <span className="hd-carry__hint" style={{ color: 'var(--hd-amber-600)' }}>
                          Directory record unavailable: {errorMessage(ctxQuery.error)}
                        </span>
                      )}
                      {ctxData && !ctxMeeting.office.memberId && (
                        <span className="hd-carry__hint" style={{ color: 'var(--hd-amber-600)' }}>
                          No member office is resolved for this meeting, so there is no Directory record to carry. Fix it in Resolution.
                        </span>
                      )}
                      <div className="hd-carry__rows">
                        {carryUnits
                          .filter((u) => u.kind === 'committees')
                          .map((u) => (
                            <button
                              key={u.id}
                              type="button"
                              className={`hd-carry__row${unitOn(u) ? ' hd-carry__row--on' : ''}`}
                              onClick={() => toggleUnit(u)}
                            >
                              <span className="hd-carry__row-label">
                                <span className={`hd-checkbox${unitOn(u) ? ' hd-checkbox--on' : ''}`} style={{ width: 16, height: 16 }}>
                                  <span className="hd-checkbox__tick" style={{ width: 9, height: 9, display: unitOn(u) ? 'block' : 'none' }} />
                                </span>
                                Committees
                              </span>
                              <span className="hd-carry__row-value">{u.detail}</span>
                            </button>
                          ))}
                        {carryUnits.some((u) => u.kind === 'issue_area') && (
                          <div style={{ display: 'flex', gap: 14, alignItems: 'baseline', padding: 8, flexWrap: narrow ? 'wrap' : undefined }}>
                            <span className="hd-carry__row-label">Issue areas</span>
                            <span className="hd-carry__issues">
                              {carryUnits
                                .filter((u) => u.kind === 'issue_area')
                                .map((u) => (
                                  <button
                                    key={u.id}
                                    type="button"
                                    className={`hd-issue-chip${unitOn(u) ? ' hd-issue-chip--on' : ''}`}
                                    onClick={() => toggleUnit(u)}
                                  >
                                    <span style={{ display: 'flex', marginTop: 1 }}>
                                      <HdIcon name={unitOn(u) ? 'Check' : 'Plus'} size={13} />
                                    </span>
                                    <span style={{ minWidth: 0 }}>{u.label}</span>
                                  </button>
                                ))}
                            </span>
                          </div>
                        )}
                        {carryUnits
                          .filter((u) => u.kind === 'bio')
                          .map((u) => (
                            <button
                              key={u.id}
                              type="button"
                              className={`hd-carry__row${unitOn(u) ? ' hd-carry__row--on' : ''}`}
                              onClick={() => toggleUnit(u)}
                            >
                              <span className="hd-carry__row-label">
                                <span className={`hd-checkbox${unitOn(u) ? ' hd-checkbox--on' : ''}`} style={{ width: 16, height: 16 }}>
                                  <span className="hd-checkbox__tick" style={{ width: 9, height: 9, display: unitOn(u) ? 'block' : 'none' }} />
                                </span>
                                Bio
                              </span>
                              <span className="hd-carry__row-value">{u.detail}</span>
                            </button>
                          ))}
                      </div>
                      <div className="hd-carry__staffers-head">
                        <span className="hd-eyebrow">Staffers in the room</span>
                        <span className="hd-carry__meta">
                          {carryUnits.some((u) => u.kind === 'staffer')
                            ? `${carryUnits.filter((u) => u.kind === 'staffer' && unitOn(u)).length} of ${carryUnits.filter((u) => u.kind === 'staffer').length} included`
                            : 'No attendees resolved yet'}
                        </span>
                      </div>
                      <div className="hd-carry__staffers">
                        {carryUnits
                          .filter((u) => u.kind === 'staffer')
                          .map((p) => {
                            const on = unitOn(p);
                            const icon: HillDayIcon = p.known ? 'User01' : p.attendeeState === 'stale' ? 'AlertTriangle' : 'HelpCircle';
                            return (
                              <button
                                key={p.id}
                                type="button"
                                className={`hd-staffer${on ? ' hd-staffer--on' : ''}${p.topics.length ? ' hd-staffer--topics' : ''}`}
                                onClick={() => toggleUnit(p)}
                              >
                                <span className="hd-staffer__row">
                                  <span className={`hd-checkbox${on ? ' hd-checkbox--on' : ''}`} style={{ width: 16, height: 16 }}>
                                    <span className="hd-checkbox__tick" style={{ width: 9, height: 9, display: on ? 'block' : 'none' }} />
                                  </span>
                                  <span className="hd-staffer__name">{p.label}</span>
                                  <span style={{ color: p.known ? 'var(--hd-green-500)' : icon === 'AlertTriangle' ? 'var(--hd-amber-500)' : 'var(--hd-gray-400)', display: 'flex' }}>
                                    <HdIcon name={icon} size={15} />
                                  </span>
                                </span>
                                <span className="hd-staffer__role">{p.detail}</span>
                                <span className="hd-staffer__topics">
                                  {p.topics.map((tp) => (
                                    <span key={tp} className="hd-topic-chip">
                                      {tp}
                                    </span>
                                  ))}
                                </span>
                              </button>
                            );
                          })}
                      </div>
                    </div>
                  </div>

                  <div className="hd-note-card">
                    <span className="hd-note-card__head">
                      <span className="hd-note-card__title">Your context for this meeting</span>
                      <span className="hd-note-card__meta">
                        {eventIndex[ctxMeeting.eventId] ? fmtTime(eventIndex[ctxMeeting.eventId]!.startsAt, tz) : ''}
                        {ctxMeeting.office.room ? ` · ${ctxMeeting.office.room}` : ''}
                        {local?.dirty ? ' · saving…' : ''}
                      </span>
                    </span>
                    <label htmlFor="hd-note">What the platform does not have</label>
                    <textarea
                      id="hd-note"
                      rows={4}
                      value={local?.note ?? ''}
                      disabled={!local}
                      onChange={(e) => updateLocal(ctxMeeting.meetingId, { note: e.target.value })}
                      placeholder="What do you know that the platform does not? Prior conversation, staff temperament, an ask that has already been declined."
                    />
                    <span className="hd-note-card__hint">
                      Goes into Background verbatim as a source. Meri will not contradict it.
                    </span>
                  </div>

                  <ThreadsCard
                    threads={ctxData?.threads ?? []}
                    loading={ctxQuery.isPending}
                    sources={ctxData?.sources ?? []}
                    selected={local?.threadIds ?? []}
                    lookback={lookback}
                    onLookback={(days) => {
                      setLookback(days);
                      if (ctxMeetingId) updateLocal(ctxMeetingId, {});
                    }}
                    onToggle={(id) => {
                      if (!local) return;
                      updateLocal(ctxMeeting.meetingId, {
                        threadIds: local.threadIds.includes(id) ? local.threadIds.filter((x) => x !== id) : [...local.threadIds, id],
                      });
                    }}
                  />
                </div>
              </div>
            )}
          </div>
        )}

        {/* Step 6 · Generate */}
        {step === 5 && (
          <div className="hd-run">
            <div className="hd-run__card">
              <div className="hd-run__head">
                <span className="hd-run__icon">
                  <HdIcon name="Stars02" size={20} />
                </span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span className="hd-run__title">
                    {jobFailed
                      ? 'Generation failed'
                      : jobDone
                        ? `${jobDone.sections - jobDone.failed} of ${jobDone.sections} prep sections drafted`
                        : 'Meri is drafting the packet'}
                  </span>
                  <span className="hd-run__sub">
                    {jobFailed
                      ? jobFailed
                      : jobDone
                        ? jobDone.failed
                          ? `${jobDone.failed} section${jobDone.failed === 1 ? '' : 's'} unavailable — flagged in the document with the reason. Open to review and regenerate.`
                          : 'Focus and Background written for every meeting. Open to edit.'
                        : 'Assembling Directory, Portfolio and Intelligence per meeting.'}
                  </span>
                </span>
                <span className="hd-run__pct">{pct}%</span>
              </div>
              <div className="hd-run__bar">
                <div className="hd-run__bar-fill" style={{ width: `${pct}%` }} />
              </div>
              <div className="hd-run__rows">
                {units.map((u) => {
                  const m = meetings.find((x) => x.meetingId === u.meetingId);
                  const ev = m ? eventIndex[m.eventId] : undefined;
                  const st = u.state;
                  const icon: HillDayIcon = st === 'done' ? 'CheckCircle' : st === 'running' ? 'Loading01' : st === 'failed' ? 'AlertTriangle' : 'Clock';
                  return (
                    <div key={u.meetingId} className={`hd-run-row hd-run-row--${st}`}>
                      <span className={`hd-run-row__icon hd-run-row__icon--${st}`}>
                        <HdIcon name={icon} size={18} className={st === 'running' ? 'hd-spin' : undefined} />
                      </span>
                      <span className="hd-run-row__time">{ev ? fmtTime(ev.startsAt, tz) : ''}</span>
                      <span className="hd-run-row__member">{m?.office.member ?? ev?.subject ?? 'Meeting'}</span>
                      <span className="hd-run-row__status">
                        {st === 'done'
                          ? u.reason === 'edited_preserved'
                            ? 'Kept your edits'
                            : 'Focus + Background'
                          : st === 'running'
                            ? 'Drafting…'
                            : st === 'failed'
                              ? `Unavailable · ${(u.reason ?? 'failed').replace(/_/g, ' ')}`
                              : 'Queued'}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
            <p className="hd-run__foot">
              Focus and Background are drafted per meeting. A failed section resolves to unavailable
              and is flagged in the document — never to an empty section.
            </p>
          </div>
        )}
      </div>

      {/* Sticky footer with the forward contract */}
      <div className="hd-flow__footer">
        <span className="hd-flow__footer-note">{busy ?? footers[step]}</span>
        <HdSecondary
          className={`hd-flow__back${step === 0 ? ' hd-flow__back--dim' : ''}`}
          disabled={Boolean(busy) || (step === 5 && !runDone)}
          onClick={() => goTo(step - 1)}
        >
          Back
        </HdSecondary>
        <HdPrimary disabled={nextDisabled} onClick={() => void next()}>
          {nextLabels[step]}
          {!nextDisabled && <HdIcon name="ArrowRight" size={16} />}
        </HdPrimary>
      </div>
    </div>
    </div>
  );
}

// ── Step 4 card ─────────────────────────────────────────────────────────────

function ResolutionCard({
  meeting,
  event,
  tz,
  lookback,
  api,
  onCorrect,
}: {
  meeting: MeetingResolution;
  event: CalendarEvent | undefined;
  tz: string;
  lookback: number;
  api: HillDayClient;
  onCorrect: (body: CorrectionBody) => Promise<void>;
}) {
  const [addOpen, setAddOpen] = useState(false);
  const [officeOpen, setOfficeOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(() => event?.source === 'manual');
  const bad = meeting.attendees.filter((a) => a.state !== 'resolved').length;
  const m = meeting;
  const duration = event ? fmtDuration(event.startsAt, event.endsAt) : '';
  return (
    <div className={`hd-resolve-card${bad || !m.office.memberId ? ' hd-resolve-card--warn' : ''}`}>
      <div className={`hd-resolve-card__head${bad || !m.office.memberId ? ' hd-resolve-card__head--warn' : ''}`}>
        <span className="hd-resolve-card__time">{event ? fmtTime(event.startsAt, tz) : ''}</span>
        <span className="hd-resolve-card__vsep" />
        <span className="hd-resolve-card__member">{m.office.member ?? event?.subject ?? 'Meeting'}</span>
        <span style={{ flex: '0 0 auto', display: 'flex' }}>
          <HdPill tone={bad || !m.office.memberId ? 'warn' : 'ok'}>
            {bad ? `${bad} needs input` : m.office.memberId ? 'Resolved' : 'Office unresolved'}
          </HdPill>
        </span>
      </div>
      <div className="hd-resolve-card__cols">
        <div className="hd-resolve-card__office">
          <span className="hd-eyebrow">Resolved office</span>
          <div className="hd-resolve-card__office-facts">
            {[
              { k: 'Member', v: m.office.member ?? 'Not resolved — choose the office', w: 600 },
              { k: 'Party · state', v: m.office.partyName ? `${m.office.partyName}${m.office.state ? ` · ${m.office.state}` : ''}` : '—', w: 500 },
              { k: 'Location', v: m.office.room ?? event?.location ?? '—', w: 500 },
              { k: 'Committees', v: m.office.committees.length ? m.office.committees.join(' · ') : '—', w: 500 },
              { k: 'Duration', v: duration || '—', w: 500 },
              {
                k: 'Derived from',
                v:
                  m.office.derivedFrom === 'user_correction'
                    ? 'Your correction'
                    : m.office.derivedFrom === 'manual_selection'
                      ? 'Picked from the Directory'
                      : m.office.derivedFrom === 'staffer_office_association'
                        ? "Staffer's office association"
                        : m.office.derivedFrom === 'invite_domain'
                          ? 'Invite address domain'
                          : m.office.derivedFrom === 'member_on_invite'
                            ? 'Member on the invite'
                            : m.office.derivedFrom === 'committee_staff_association'
                              ? 'Committee staff (no member office)'
                              : 'Nothing yet',
                w: 500,
              },
            ].map((f) => (
              <span key={f.k} className="hd-fact-row">
                <span className="hd-fact-row__k">{f.k}</span>
                <span className="hd-fact-row__v" style={{ fontWeight: f.w }}>
                  {f.v}
                </span>
              </span>
            ))}
          </div>
          <button type="button" className="hd-resolve-card__change-office" onClick={() => setOfficeOpen((o) => !o)}>
            <HdIcon name="SwitchHorizontal01" size={15} />
            Change office
          </button>
          {officeOpen && (
            <MemberSearch
              api={api}
              alternatives={m.office.alternatives}
              onPick={async (memberId) => {
                await onCorrect({ kind: 'change_office', memberId });
                setOfficeOpen(false);
              }}
            />
          )}
          <button type="button" className="hd-resolve-card__change-office" onClick={() => setEditOpen((o) => !o)}>
            <HdIcon name="ClipboardCheck" size={15} />
            Edit details
          </button>
          {editOpen && (
            <EditMeetingFactsForm
              event={event}
              tz={tz}
              onSubmit={async (body) => {
                await onCorrect(body);
                setEditOpen(false);
              }}
            />
          )}
        </div>
        <div className="hd-resolve-card__atts">
          <span className="hd-resolve-card__atts-head">
            <span className="hd-eyebrow">Attendees</span>
            <span className="hd-resolve-card__atts-meta">
              {m.attendees.length} on the invite · {lookback}-day history
              {m.internalParticipants.length ? ` · ${m.internalParticipants.length} from your side` : ''}
            </span>
          </span>
          <div className="hd-att-list">
            {m.attendees.map((a) => (
              <AttendeeRow key={a.attendeeId} attendee={a} api={api} onCorrect={onCorrect} />
            ))}
            {m.attendees.length === 0 && (
              <div className="hd-att">
                <span className="hd-att__detail">No external attendees on the invite.</span>
              </div>
            )}
          </div>
          <button type="button" className="hd-resolve-card__add-att" onClick={() => setAddOpen((o) => !o)}>
            <HdIcon name="Plus" size={15} />
            Add attendee manually
          </button>
          {addOpen && (
            <ManualAttendeeForm
              api={api}
              onSubmit={async (body) => {
                await onCorrect(body);
                setAddOpen(false);
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function AttendeeRow({
  attendee: a,
  api,
  onCorrect,
}: {
  attendee: ResolvedAttendee;
  api: HillDayClient;
  onCorrect: (body: CorrectionBody) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const meta = STATE_META[a.state];
  const confirmed = Boolean(a.correction);
  const ok = meta.ok;
  const stateLabel = confirmed && ok ? 'Confirmed' : meta.label;
  const needsFix = !ok;
  return (
    <div className={['hd-att', open ? 'hd-att--fix-open' : '', needsFix ? 'hd-att--needs-fix hd-att--warn' : ''].join(' ')}>
      <span className="hd-att__row">
        <span className={`hd-att__icon hd-att__icon--${ok ? 'ok' : 'warn'}`}>
          <HdIcon name={ok ? 'CheckCircle' : meta.icon} size={16} />
        </span>
        <span className="hd-att__name">{a.name ?? a.address ?? 'Attendee'}</span>
        <span className={`hd-att__state${ok ? ' hd-att__state--ok' : ''}`}>{stateLabel}</span>
      </span>
      <span className="hd-att__detail">
        {a.role ? `${a.role}${a.address ? ` · ${a.address}` : ''}` : a.address ?? ''}
        {a.role || a.address ? ' — ' : ''}
        {a.detail}
        {a.directoryRecord ? ' Directory record created.' : ''}
      </span>
      {a.state === 'stale' && (
        <span className="hd-att__fix" style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {a.directoryOffice && (
            <button type="button" className="hd-att__fix-btn" onClick={() => void onCorrect({ kind: 'accept_stale', attendeeId: a.attendeeId, useOffice: 'directory' })}>
              <HdIcon name="Check" size={15} />
              Use {a.directoryOffice.memberName ?? 'Directory'} office
            </button>
          )}
          {a.inviteOffice && (
            <button type="button" className="hd-att__fix-btn" onClick={() => void onCorrect({ kind: 'accept_stale', attendeeId: a.attendeeId, useOffice: 'invite' })}>
              <HdIcon name="Check" size={15} />
              Use {a.inviteOffice.memberName ?? 'invite'} office
            </button>
          )}
        </span>
      )}
      {(a.state === 'unresolved' || a.state === 'scheduler') && !open && (
        <span className="hd-att__fix" style={{ display: 'flex' }}>
          <button type="button" className="hd-att__fix-btn" onClick={() => setOpen(true)}>
            <HdIcon name={a.state === 'scheduler' ? 'Plus' : 'UserCheck01'} size={15} />
            {a.state === 'scheduler' ? 'Add attendee' : 'Resolve'}
          </button>
        </span>
      )}
      {(a.state === 'unresolved' || a.state === 'scheduler') && open && (
        <ManualAttendeeForm
          api={api}
          initialName={a.state === 'unresolved' && a.name && a.name !== a.address ? a.name : ''}
          attendeeId={a.state === 'unresolved' ? a.attendeeId : undefined}
          address={a.state === 'unresolved' ? a.address ?? undefined : undefined}
          allowCreateRecord={a.state === 'unresolved' && Boolean(a.address)}
          onSubmit={async (body) => {
            await onCorrect(body);
            setOpen(false);
          }}
        />
      )}
    </div>
  );
}

function ManualAttendeeForm({
  api,
  initialName = '',
  attendeeId,
  address,
  allowCreateRecord = false,
  onSubmit,
}: {
  api: HillDayClient;
  initialName?: string;
  attendeeId?: string;
  address?: string;
  allowCreateRecord?: boolean;
  onSubmit: (body: CorrectionBody) => Promise<void>;
}) {
  const [name, setName] = useState(initialName);
  const [role, setRole] = useState('');
  const [q, setQ] = useState('');
  const search = useQuery({
    queryKey: ['hd', 'staffers', q],
    queryFn: () => api.searchStaffers(q),
    enabled: q.trim().length >= 2,
    staleTime: 60_000,
  });
  const canConfirm = name.trim().length > 0;
  return (
    <span className="hd-att__fix" style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'stretch' }}>
      <span style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <input type="text" placeholder="Full name" aria-label="Full name" value={name} onChange={(e) => setName(e.target.value)} />
        <input type="text" placeholder="Title or role" aria-label="Title or role" value={role} onChange={(e) => setRole(e.target.value)} />
        <button
          type="button"
          className="hd-att__fix-btn"
          disabled={!canConfirm}
          onClick={() => void onSubmit({ kind: 'manual_attendee', attendeeId, name: name.trim(), role: role.trim() || undefined, address })}
        >
          <HdIcon name="Check" size={15} />
          Confirm
        </button>
        {allowCreateRecord && (
          <button
            type="button"
            className="hd-att__fix-btn"
            disabled={!canConfirm}
            onClick={() => void onSubmit({ kind: 'create_directory_record', attendeeId, name: name.trim(), role: role.trim() || undefined, address })}
          >
            <HdIcon name="UserCheck01" size={15} />
            Create Directory record
          </button>
        )}
      </span>
      <span style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <input type="text" placeholder="Or search the Directory by name…" aria-label="Search Directory staffers" value={q} onChange={(e) => setQ(e.target.value)} />
        {search.isFetching && <span className="hd-att__detail">Searching…</span>}
        {search.data && degradedSources(search.data.sources).length > 0 && (
          <span className="hd-att__detail">Directory unavailable right now.</span>
        )}
      </span>
      {search.data?.staffers.slice(0, 6).map((s) => (
        <button
          key={s.id}
          type="button"
          className="hd-att__fix-btn"
          style={{ justifyContent: 'flex-start', textAlign: 'left' }}
          onClick={() => void onSubmit({ kind: 'assign_staffer', attendeeId, stafferId: s.id, address })}
        >
          <HdIcon name="UserCheck01" size={15} />
          {s.name} — {s.title}
          {s.member?.memberName ? ` · ${s.member.memberName}` : ''}
        </button>
      ))}
    </span>
  );
}

function MemberSearch({
  api,
  alternatives,
  onPick,
}: {
  api: HillDayClient;
  alternatives: MeetingResolution['office']['alternatives'];
  onPick: (memberId: string) => Promise<void>;
}) {
  const [q, setQ] = useState('');
  const search = useQuery({
    queryKey: ['hd', 'members', q],
    queryFn: () => api.searchMembers(q),
    enabled: q.trim().length >= 2,
    staleTime: 60_000,
  });
  return (
    <span className="hd-att__fix" style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'stretch', marginTop: 8 }}>
      {alternatives.filter((alt) => alt.memberId).map((alt) => (
        <button key={alt.memberId} type="button" className="hd-att__fix-btn" style={{ justifyContent: 'flex-start' }} onClick={() => void onPick(alt.memberId!)}>
          <HdIcon name="SwitchHorizontal01" size={15} />
          Use {alt.member}
        </button>
      ))}
      <input type="text" placeholder="Search members by name or state…" aria-label="Search Directory members" value={q} onChange={(e) => setQ(e.target.value)} />
      {search.isFetching && <span className="hd-att__detail">Searching…</span>}
      {search.data && degradedSources(search.data.sources).length > 0 && <span className="hd-att__detail">Directory unavailable right now.</span>}
      {search.data?.members.slice(0, 6).map((mem) => (
        <button key={mem.memberId ?? mem.member ?? ''} type="button" className="hd-att__fix-btn" style={{ justifyContent: 'flex-start' }} onClick={() => mem.memberId && void onPick(mem.memberId)}>
          <HdIcon name="Check" size={15} />
          {mem.member}
        </button>
      ))}
    </span>
  );
}

function EditMeetingFactsForm({
  event,
  tz,
  onSubmit,
}: {
  event: CalendarEvent | undefined;
  tz: string;
  onSubmit: (body: CorrectionBody) => Promise<void>;
}) {
  const [subject, setSubject] = useState(event?.subject ?? '');
  const [dateKey, setDateKey] = useState(event ? localDateKey(event.startsAt, tz) : '');
  const [startTime, setStartTime] = useState(event ? localTimeKey(event.startsAt, tz) : '');
  const [endTime, setEndTime] = useState(event ? localTimeKey(event.endsAt, tz) : '');
  const [location, setLocation] = useState(event?.location ?? '');
  const timesInvalid = startTime.length > 0 && endTime.length > 0 && endTime <= startTime;
  const canConfirm = subject.trim().length > 0 && dateKey.length > 0 && startTime.length > 0 && endTime.length > 0 && !timesInvalid;
  return (
    <span className="hd-att__fix" style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'stretch' }}>
      <span style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <input
          type="text"
          placeholder="Subject"
          aria-label="Meeting subject"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          style={{ flex: '1 1 200px' }}
        />
        <input
          type="text"
          placeholder="Location"
          aria-label="Location"
          value={location ?? ''}
          onChange={(e) => setLocation(e.target.value)}
          style={{ flex: '1 1 160px' }}
        />
      </span>
      <span style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <input type="date" aria-label="Date" value={dateKey} onChange={(e) => setDateKey(e.target.value)} />
        <input type="time" aria-label="Start time" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
        <span className="hd-att__detail">to</span>
        <input type="time" aria-label="End time" value={endTime} onChange={(e) => setEndTime(e.target.value)} />
        {timesInvalid && <span className="hd-att__detail">End must be after start.</span>}
      </span>
      <span>
        <button
          type="button"
          className="hd-att__fix-btn"
          disabled={!canConfirm}
          onClick={() =>
            void onSubmit({
              kind: 'edit_meeting_facts',
              subject: subject.trim(),
              startsAt: zonedInstantUtc(dateKey, startTime, tz),
              endsAt: zonedInstantUtc(dateKey, endTime, tz),
              location: location?.trim() || undefined,
            })
          }
        >
          <HdIcon name="Check" size={15} />
          Save details
        </button>
      </span>
    </span>
  );
}

// ── Step 5 correspondence ───────────────────────────────────────────────────

function ThreadsCard({
  threads,
  loading,
  sources,
  selected,
  lookback,
  onLookback,
  onToggle,
}: {
  threads: ThreadRef[];
  loading: boolean;
  sources: SourceStatusBlock[];
  selected: string[];
  lookback: number;
  onLookback: (days: number) => void;
  onToggle: (id: string) => void;
}) {
  const included = threads.filter((t) => selected.includes(t.id)).length;
  const degraded = degradedSources(sources).find((s) => s.source === 'correspondence');
  return (
    <div className="hd-threads">
      <div className="hd-threads__head">
        <span className="hd-threads__title">Correspondence</span>
        <span className="hd-threads__meta">
          {loading
            ? 'Loading…'
            : degraded
              ? `Unavailable${degraded.detail ? ` — ${degraded.detail}` : ''}`
              : threads.length
                ? `${threads.length} found · ${included} included`
                : 'None in window'}
        </span>
        <label className="hd-threads__window">
          <HdIcon name="ClockRewind" size={15} />
          <span>Last</span>
          <select
            aria-label="Correspondence lookback window"
            value={lookback}
            onChange={(e) => onLookback(Number(e.target.value))}
            style={{ background: 'transparent', border: 0, font: 'inherit', color: 'inherit' }}
          >
            {LOOKBACK_OPTIONS.map((d) => (
              <option key={d} value={d}>
                {d} days
              </option>
            ))}
          </select>
          <HdIcon name="ChevronDown" size={15} />
        </label>
      </div>
      {threads.map((t) => {
        const on = selected.includes(t.id);
        return (
          <button
            key={t.id}
            type="button"
            className={`hd-threads__row${on ? ' hd-threads__row--on' : ''}`}
            onClick={() => onToggle(t.id)}
          >
            <span style={{ flex: '0 0 auto', display: 'flex' }}>
              <span className={`hd-checkbox${on ? ' hd-checkbox--on' : ''}`} style={{ width: 18, height: 18, borderRadius: 5 }}>
                <span className="hd-checkbox__tick" style={{ width: 11, height: 11, display: on ? 'block' : 'none' }} />
              </span>
            </span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span className="hd-threads__subject">{t.subject}</span>
              <span className="hd-threads__sub">
                {t.participants.slice(0, 2).join(', ') || 'Participants not listed'} · {t.messageCount} message{t.messageCount === 1 ? '' : 's'}
                {t.clientTagged ? ' · tagged to client' : ''}
              </span>
            </span>
            <span className="hd-threads__age">{t.ageDays === null ? '—' : `${t.ageDays} days`}</span>
          </button>
        );
      })}
      <div className="hd-threads__foot">
        Threads outside the window are excluded rather than summarised. Widen the window if a
        decision predates it.
      </div>
    </div>
  );
}
