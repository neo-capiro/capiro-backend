import { createContext, useContext, type ReactNode } from 'react';

/**
 * Surface-injected confirm/toast chrome for the shared Meetings drawer tree
 * (MeetingDetailPanel + PrepTab/NotesTab/DebriefTab + ShareConfirmation).
 *
 * Those components are rendered by BOTH surfaces of the one-bundle web app:
 * the canonical Meetings page on app.capiro.ai (which speaks AntD
 * `modal.confirm` / `message.*`) and the vNext Engagement workspace on
 * os.capiro.ai (where no AntD may render — vNext purge directive). The
 * components themselves therefore no longer import `antd`; they ask this
 * context for their confirm dialogs and transient toasts, and each surface
 * mounts the provider that matches its design system:
 *
 *   - `AntdMeetingPanelChrome.tsx` (canonical, wraps `App.useApp()`) — mounted
 *     by MeetingsV2.tsx, preserving the exact AntD dialogs/toasts the
 *     canonical page has always shown.
 *   - `VNextMeetingPanelChrome.tsx` (vnext/pages/engagement) — an
 *     EngagementDialog confirm + `useCapiroToast` notifications, mounted by
 *     VNextMeetingsWorkspace.tsx.
 *
 * This file must stay free of `antd` imports and css imports: it is part of
 * the vNext surface's runtime import graph.
 */

export interface MeetingPanelConfirmOptions {
  title: string;
  content: string;
  okText: string;
  /** Renders the confirm action as destructive (AntD `danger`, vNext red). */
  danger?: boolean;
  /**
   * Runs when the user confirms. AntD semantics are preserved by both
   * providers: the dialog closes when the promise resolves and stays open if
   * it rejects.
   */
  onOk: () => Promise<void> | void;
}

export interface MeetingPanelChrome {
  confirm: (options: MeetingPanelConfirmOptions) => void;
  success: (text: string) => void;
  error: (text: string) => void;
  warning: (text: string) => void;
}

/**
 * Outside a provider (unit tests rendering a tab in isolation, or a future
 * un-wrapped host), toasts are dropped — they are non-critical feedback, so
 * dropping them is strictly better than throwing (same reasoning as
 * useCapiroToast / useEngagementToast). `confirm` degrades to the browser's
 * own confirm so a destructive action still never runs un-confirmed; in jsdom
 * `window.confirm` returns falsy, so tests simply don't take the destructive
 * branch unless they provide a chrome of their own.
 */
const FALLBACK_CHROME: MeetingPanelChrome = {
  confirm: ({ title, content, onOk }) => {
    if (window.confirm(`${title}\n\n${content}`)) void onOk();
  },
  success: () => {},
  error: () => {},
  warning: () => {},
};

const MeetingPanelChromeContext = createContext<MeetingPanelChrome | null>(null);

export function useMeetingPanelChrome(): MeetingPanelChrome {
  return useContext(MeetingPanelChromeContext) ?? FALLBACK_CHROME;
}

export function MeetingPanelChromeProvider({
  chrome,
  children,
}: {
  chrome: MeetingPanelChrome;
  children: ReactNode;
}) {
  return (
    <MeetingPanelChromeContext.Provider value={chrome}>
      {children}
    </MeetingPanelChromeContext.Provider>
  );
}
