import type { NavigateFunction } from 'react-router-dom';
import { Typography } from 'antd';

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
    const state = window.history.state as { idx?: number } | null;
    const idx = state && typeof state.idx === 'number' ? state.idx : 0;
    if (idx > 0) navigate(-1);
    else navigate(fallback);
  };
  return (
    <Typography.Link onClick={onBack} data-testid="profile-back-link">
      {label}
    </Typography.Link>
  );
}
