import { useMemo, type ReactNode } from 'react';
import { App } from 'antd';
import { MeetingPanelChromeProvider, type MeetingPanelChrome } from './meeting-panel-chrome.js';

/**
 * Canonical (app.capiro.ai) provider for the Meetings drawer chrome: exactly
 * the AntD `modal.confirm` / `message.*` calls the drawer components used to
 * make inline, including the `rootClassName: 'redesign'` and danger button
 * both existing confirms (Unshare all, Cancel Meri) always passed. Mounted by
 * MeetingsV2.tsx around the detail panel and its sibling modals.
 *
 * This file is canonical-only on purpose — it is the ONE place the shared
 * drawer tree still touches `antd`, and nothing under `src/vnext/**` may
 * import it.
 */
export function AntdMeetingPanelChrome({ children }: { children: ReactNode }) {
  const { modal, message } = App.useApp();

  const chrome = useMemo<MeetingPanelChrome>(
    () => ({
      confirm: ({ title, content, okText, danger, onOk }) => {
        modal.confirm({
          title,
          content,
          okText,
          okButtonProps: danger ? { danger: true } : undefined,
          rootClassName: 'redesign',
          onOk,
        });
      },
      success: (text) => {
        void message.success(text);
      },
      error: (text) => {
        void message.error(text);
      },
      warning: (text) => {
        void message.warning(text);
      },
    }),
    [modal, message],
  );

  return <MeetingPanelChromeProvider chrome={chrome}>{children}</MeetingPanelChromeProvider>;
}
