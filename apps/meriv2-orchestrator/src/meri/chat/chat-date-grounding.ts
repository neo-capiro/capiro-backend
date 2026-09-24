export const DEFAULT_CHAT_TIME_ZONE = 'America/New_York';

export interface ChatDateGrounding {
  timeZone: string;
  date: string;
}

/** Resolve one instant to a validated user-local calendar day. */
export function resolveChatDateGrounding(
  timeZone: string | undefined,
  now: Date,
): ChatDateGrounding {
  let resolvedTimeZone = DEFAULT_CHAT_TIME_ZONE;
  if (timeZone) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone }).format(now);
      resolvedTimeZone = timeZone;
    } catch {
      // Corrupt or unsupported values fall back to the stable product default.
    }
  }
  const dateParts = new Intl.DateTimeFormat('en-US', {
    timeZone: resolvedTimeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const dateValues = Object.fromEntries(dateParts.map(({ type, value }) => [type, value]));
  return {
    timeZone: resolvedTimeZone,
    date: `${dateValues.year}-${dateValues.month}-${dateValues.day}`,
  };
}
