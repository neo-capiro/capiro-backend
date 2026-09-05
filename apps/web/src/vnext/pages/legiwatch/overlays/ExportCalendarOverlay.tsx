/**
 * Export calendar overlay (LEGIWATCH-V2-HANDOFF §2 header action) — a real
 * multi-hearing .ics download over the current week's public schedule.
 *
 * Scoped deliberately to "this week": lifting the Schedule tab's live
 * committee/text filters up to the module header would require threading
 * that state through a second component tree, so this offers an honest,
 * clearly-labelled window (Mon–Sun, computed here) rather than silently
 * mislabeling a narrower export as "your current view".
 */
import { useMemo, useState } from 'react';
import { LwModal } from './LwModal.js';
import { useCalendarExportBulk, downloadIcs } from '../lib/wave1-api.js';

function mondayOf(d: Date): Date {
  const day = d.getUTCDay(); // 0=Sun..6=Sat
  const delta = day === 0 ? -6 : 1 - day;
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + delta));
  return monday;
}

function fmt(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function ExportCalendarOverlay({ scope: _scope, onClose }: { scope: string; onClose: () => void }) {
  const [status, setStatus] = useState<'idle' | 'done' | 'error'>('idle');
  const [detail, setDetail] = useState<string | null>(null);
  const bulk = useCalendarExportBulk();

  const { from, to, label } = useMemo(() => {
    const monday = mondayOf(new Date());
    const sunday = new Date(monday.getTime() + 6 * 24 * 60 * 60 * 1000);
    return {
      from: fmt(monday),
      to: fmt(sunday),
      label: `${monday.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${sunday.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`,
    };
  }, []);

  const onDownload = () => {
    setStatus('idle');
    bulk.mutate(
      { from, to },
      {
        onSuccess: (result) => {
          downloadIcs(result);
          setDetail(
            result.includedCount === 0
              ? 'No public proceedings fall in this window.'
              : `${result.includedCount} proceeding${result.includedCount === 1 ? '' : 's'} exported${result.skipped.length ? ` · ${result.skipped.length} skipped (no usable date)` : ''}.`,
          );
          setStatus('done');
        },
        onError: () => setStatus('error'),
      },
    );
  };

  return (
    <LwModal
      kind="export"
      eyebrow="Hearings · Schedule"
      title="Export calendar"
      subtitle="Download the current week's public proceedings as one .ics file."
      note="Public-record dates only. Closed sessions are never included."
      primaryLabel={bulk.isPending ? 'Preparing…' : 'Download .ics'}
      onPrimary={onDownload}
      primaryDisabled={bulk.isPending}
      onClose={onClose}
    >
      <div className="lw-block" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ fontSize: 14, fontWeight: 600 }}>This week</div>
        <div className="lw-mono" style={{ fontSize: 12, color: 'var(--lw-meta)' }}>{label}</div>
        {status === 'done' && detail ? (
          <p className="lw-state__body" style={{ maxWidth: 'none', margin: 0 }}>{detail}</p>
        ) : null}
        {status === 'error' ? (
          <p className="lw-state__body" style={{ maxWidth: 'none', margin: 0, color: 'var(--lw-error-fg)' }}>
            The calendar export failed. Nothing was downloaded — try again.
          </p>
        ) : null}
        <p className="lw-state__body" style={{ maxWidth: 'none', margin: 0 }}>
          To export a single proceeding to Google Calendar or Outlook, use the Export control on that
          hearing's detail page.
        </p>
      </div>
    </LwModal>
  );
}
