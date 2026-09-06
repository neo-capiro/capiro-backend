import type { DelegatedToolSpec } from '@capiro/meriv2-core';
import { meriCapabilitiesForSurface } from '@capiro/shared';

/** Derived from the authoritative capability registry; surfaces are explicit. */
export const WRITE_DELEGATED_TOOLS: readonly DelegatedToolSpec[] = meriCapabilitiesForSurface(
  'full_chat',
)
  .filter((tool) => !tool.readOnly)
  .map(({ name, description, readOnly }) => ({ name, description, readOnly }));
