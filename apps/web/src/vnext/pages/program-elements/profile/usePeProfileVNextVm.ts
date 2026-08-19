/**
 * usePeProfileVNextVm — vNext binding of the shared PE line-profile view-model.
 *
 * VNextRouter mounts this module ABOVE the canonical param `<Route>`s, so
 * `useParams` is EMPTY here (Phase 3 lesson #2). The PE code is parsed (and
 * decoded) from location.pathname via the module route matcher instead; tests
 * and the entry component may also pass it explicitly.
 *
 * The watch toggle is PE-CORE's vNext binding of the shared optimistic
 * mutation (pe-watch-toggle.ts): same logic and error copy as canonical,
 * Capiro toast instead of antd `message`.
 */
import { useLocation } from 'react-router-dom';
import { useProgramElementProfileFinalCore } from '../../../../pages/program-element/useProgramElementProfileFinalCore.js';
import { matchPeProfilePath } from '../pe-routes.js';
import { useWatchToggle } from '../pe-watch-toggle.js';

export function usePeProfileVNextVm(peCodeOverride?: string) {
  const location = useLocation();
  const watch = useWatchToggle();
  const peCode = peCodeOverride ?? matchPeProfilePath(location.pathname) ?? '';
  return useProgramElementProfileFinalCore({ peCode, watch });
}
