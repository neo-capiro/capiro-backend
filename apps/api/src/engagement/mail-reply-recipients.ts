/** Captured visible recipients only. Bcc and provider aliases are never inferred. */
export type MailReplyRecipients = { to: string[]; cc: string[] };
export type PreparedReplyAll = { original: MailReplyRecipients; to: string[]; cc: string[] };

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

// Intentionally supports one unambiguous address. Complex lists are unsupported,
// never partially parsed into a different recipient. No alias identity is inferred.
export function mailReplyAddress(value: string): string | null {
  const match = /^(?:[^<>@,;\r\n]*<([^<>]+)>|([^<>]+))$/.exec(value.trim());
  const email = (match?.[1] ?? match?.[2] ?? '').trim().toLowerCase();
  return email.length <= 254 &&
    /^[a-z0-9.!#$%&'*+\-/=?^_`{|}~]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i.test(email)
    ? email
    : null;
}

function addresses(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > 100) return null;
  const rows = value.map((item) => (typeof item === 'string' ? mailReplyAddress(item) : null));
  return rows.some((item) => !item) ? null : (rows as string[]);
}

export function capturedGraphReplyRecipients(value: unknown): MailReplyRecipients | null {
  const raw = object(value);
  const list = (items: unknown) =>
    Array.isArray(items)
      ? addresses(items.map((item) => object(object(item).emailAddress).address))
      : null;
  const to = list(raw.toRecipients),
    cc = list(raw.ccRecipients);
  return to && cc && to.length + cc.length <= 100 ? { to, cc } : null;
}

export function capturedGmailReplyRecipients(value: unknown): MailReplyRecipients | null {
  const headers = object(object(value).payload).headers;
  if (!Array.isArray(headers) || headers.length > 200) return null;
  const list = (name: string, optional = false): string[] | null => {
    const rows = headers
      .map(object)
      .filter((row) => typeof row.name === 'string' && row.name.toLowerCase() === name);
    if (!rows.length && optional) return [];
    if (
      rows.length !== 1 ||
      typeof rows[0]!.value !== 'string' ||
      rows[0]!.value.length > 8192 ||
      /[\x00-\x1f\x7f]/.test(rows[0]!.value)
    )
      return null;
    // Quoted commas/groups require a full mailbox parser and are refused as a
    // whole. A partial split can never turn into an admitted recipient set.
    return addresses(rows[0]!.value.split(','));
  };
  const to = list('to'),
    cc = list('cc', true);
  return to && cc && to.length + cc.length <= 100 ? { to, cc } : null;
}

export function storedReplyRecipients(value: unknown): MailReplyRecipients | null {
  const raw = object(value);
  if (Object.keys(raw).sort().join(',') !== 'cc,to') return null;
  const to = addresses(raw.to),
    cc = addresses(raw.cc);
  return to &&
    cc &&
    to.length + cc.length <= 100 &&
    JSON.stringify({ to, cc }) === JSON.stringify({ to: raw.to, cc: raw.cc })
    ? { to, cc }
    : null;
}

export function prepareReplyAllRecipients(
  original: MailReplyRecipients,
  replyTo: string,
  selfEmails: readonly string[],
): PreparedReplyAll | null {
  const self = new Set(selfEmails.map((email) => email.trim().toLowerCase()));
  if (![...original.to, ...original.cc].some((email) => self.has(email)) || self.has(replyTo))
    return null;
  const seen = new Set(self);
  const keep = (items: string[]) =>
    items.filter((email) => {
      if (seen.has(email)) return false;
      seen.add(email);
      return true;
    });
  const to = keep([replyTo, ...original.to]),
    cc = keep(original.cc);
  return to.length && to.length <= 50 && cc.length <= 10 ? { original, to, cc } : null;
}

/** Closed server-authored recipient proof retained in the canonical intent. */
export function storedPreparedReplyAll(value: unknown): PreparedReplyAll | null {
  const raw = object(value),
    original = storedReplyRecipients(raw.original);
  const to = addresses(raw.to),
    cc = addresses(raw.cc);
  if (
    Object.keys(raw).sort().join(',') !== 'cc,original,to' ||
    !original ||
    !to?.length ||
    to.length > 50 ||
    !cc ||
    cc.length > 10 ||
    new Set([...to, ...cc]).size !== to.length + cc.length ||
    JSON.stringify({ to, cc }) !== JSON.stringify({ to: raw.to, cc: raw.cc })
  )
    return null;
  return { original, to, cc };
}

export function replyRecipientsMatch(
  replyTo: string,
  proof: unknown,
  to: Array<{ email: string }>,
  cc: Array<{ email: string }> = [],
  bcc: Array<{ email: string }> = [],
): boolean {
  const all = proof === undefined ? undefined : storedPreparedReplyAll(proof);
  if (bcc.length || (proof !== undefined && (!all || all.to[0] !== replyTo))) return false;
  return (
    JSON.stringify(to.map((row) => row.email.trim().toLowerCase())) ===
      JSON.stringify(all?.to ?? [replyTo]) &&
    JSON.stringify(cc.map((row) => row.email.trim().toLowerCase())) ===
      JSON.stringify(all?.cc ?? [])
  );
}
