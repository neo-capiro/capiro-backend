/** Translate machine-owned activity metadata without rewriting a person's note. */
const ACTIVITY_LABELS: Record<string, string> = {
  'fill-with-meri-capability': 'Capability document added with Meri',
  intel_memo: 'Intelligence memo',
  briefing_memo: 'Briefing memo',
  draft: 'Draft',
  sent: 'Sent',
  completed: 'Completed',
  pending: 'Pending',
};

export function activityBodyLabel(item: { origin: string; body: string | null }): string | null {
  if (!item.body || item.origin !== 'derived') return item.body;
  return item.body.split(' · ').map((part) => ACTIVITY_LABELS[part] ?? part).join(' · ');
}

/** datetime-local values are interpreted in the user's local time zone. */
export function localActivityDate(iso: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(iso);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const date = new Date(year, month - 1, day, hour, minute);
  // Reject normalized invalid dates and nonexistent times at a DST transition.
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day
    || date.getHours() !== hour || date.getMinutes() !== minute) return null;
  return date.toISOString();
}

export function localActivityNow(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
}
