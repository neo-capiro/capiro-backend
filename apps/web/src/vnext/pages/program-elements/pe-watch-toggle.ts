/**
 * vNext binding of the shared optimistic watch toggle.
 *
 * Same mutation, same optimistic cache patching, same invalidations and the
 * same error copy as the canonical `useWatchToggle` (pe-shared.tsx) — the only
 * difference is the notification transport: Capiro toast instead of antd
 * `message`. Logic lives in pages/program-element/pe-shared-model.ts (UI-free).
 */
import { useWatchToggleCore } from '../../../pages/program-element/pe-shared-model.js';
import { useCapiroToast } from '../../components/feedback/toast.js';

export function useWatchToggle() {
  const toast = useCapiroToast();
  return useWatchToggleCore(toast.error);
}
