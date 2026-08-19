/**
 * useProgramElementProfileFinal — canonical wrapper around the UI-free core
 * (useProgramElementProfileFinalCore.ts, extracted for the vNext no-legacy-UI
 * contract). Supplies `peCode` from the canonical param route and the
 * antd-toast watch toggle; everything else — endpoints, query keys,
 * derivations, CSV export — is the shared core. Public API unchanged.
 */
import { useParams } from 'react-router-dom';
import { useWatchToggle } from './pe-shared.js';
import { useProgramElementProfileFinalCore } from './useProgramElementProfileFinalCore.js';

export {
  PROGRAM_ELEMENT_PROFILE_SECTIONS,
  toProgramElementHistoryRows,
} from './useProgramElementProfileFinalCore.js';
export type {
  ProgramElementProfileSection,
  ProgramElementProfileFinalVm,
} from './useProgramElementProfileFinalCore.js';

export function useProgramElementProfileFinal() {
  const { peCode = '' } = useParams<{ peCode: string }>();
  const watch = useWatchToggle();
  return useProgramElementProfileFinalCore({ peCode, watch });
}
