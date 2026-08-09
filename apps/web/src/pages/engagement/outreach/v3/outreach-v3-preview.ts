/**
 * Session-scoped Outreach V3 UI preview activation.
 *
 * V3 is deliberately independent from the Engagement API preview switch:
 * the dark runtime can be exercised with Classic Outreach, and the new UI can
 * be activated only after the accepted Figma contract is ready for review.
 * Both switches must be active before OutreachWizardRouter renders V3.
 */
export type OutreachV3PreviewMode = 'off' | 'v3';

export const OUTREACH_V3_PREVIEW_STORAGE_KEY = 'capiro.outreach-v3-preview';
export const OUTREACH_V3_PREVIEW_QUERY_PARAM = 'outreach-v3-preview';

const ACTIVE_VALUE: OutreachV3PreviewMode = 'v3';
const DEACTIVATION_VALUE = 'off';

function sessionStore(): Storage | null {
  try {
    if (typeof window === 'undefined') return null;
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export function readOutreachV3PreviewMode(): OutreachV3PreviewMode {
  const store = sessionStore();
  if (!store) return 'off';
  try {
    return store.getItem(OUTREACH_V3_PREVIEW_STORAGE_KEY) === ACTIVE_VALUE
      ? ACTIVE_VALUE
      : 'off';
  } catch {
    return 'off';
  }
}

export function isOutreachV3PreviewActive(): boolean {
  return readOutreachV3PreviewMode() === ACTIVE_VALUE;
}

export function activateOutreachV3Preview(): void {
  const store = sessionStore();
  if (!store) return;
  try {
    store.setItem(OUTREACH_V3_PREVIEW_STORAGE_KEY, ACTIVE_VALUE);
  } catch {
    // Fail closed. The user remains on Classic Outreach.
  }
}

export function clearOutreachV3Preview(): void {
  const store = sessionStore();
  if (!store) return;
  try {
    store.removeItem(OUTREACH_V3_PREVIEW_STORAGE_KEY);
  } catch {
    // Fail closed. An unreadable store can never activate V3.
  }
}

export interface OutreachV3PreviewActivationResult {
  mode: OutreachV3PreviewMode;
  changed: boolean;
  nextSearch: string;
}

/**
 * Consume only the Outreach V3 activation parameter. Every unrelated query
 * parameter is preserved. Unknown values are removed but cannot change mode.
 */
export function consumeOutreachV3PreviewActivation(
  search: string,
): OutreachV3PreviewActivationResult {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  if (!params.has(OUTREACH_V3_PREVIEW_QUERY_PARAM)) {
    return { mode: readOutreachV3PreviewMode(), changed: false, nextSearch: search };
  }

  const raw = params.get(OUTREACH_V3_PREVIEW_QUERY_PARAM);
  params.delete(OUTREACH_V3_PREVIEW_QUERY_PARAM);

  if (raw === ACTIVE_VALUE) activateOutreachV3Preview();
  else if (raw === DEACTIVATION_VALUE) clearOutreachV3Preview();

  const remaining = params.toString();
  return {
    mode: readOutreachV3PreviewMode(),
    changed: true,
    nextSearch: remaining ? `?${remaining}` : '',
  };
}
