import type { NavigateFunction } from 'react-router-dom';
import { Typography } from 'antd';
// historyCanGoBack moved to directory-profile-shared.ts (UI-free) so the
// vNext back link shares the exact same pop-vs-fallback decision.
import { historyCanGoBack } from './directory-profile-shared.js';

/**
 * Context-aware "back" for the deep-linkable profile pages. Returns to wherever the
 * user came from (the client Targets tab, the directory, a committee page, …) via
 * browser history, instead of always hard-linking to /directory. Falls back to a
 * fixed destination only on a cold deep-link (no in-app history to pop).
 *
 * React Router v6 stamps a monotonic `idx` on history.state; idx === 0 means this is
 * the first entry in the app's history stack, so there's nothing to go back to.
 */
export function ProfileBackLink({
  navigate,
  fallback = '/directory',
  label = '← Back',
}: {
  navigate: NavigateFunction;
  fallback?: string;
  label?: string;
}) {
  const onBack = () => {
    if (historyCanGoBack()) navigate(-1);
    else navigate(fallback);
  };
  return (
    <Typography.Link onClick={onBack} data-testid="profile-back-link">
      {label}
    </Typography.Link>
  );
}
