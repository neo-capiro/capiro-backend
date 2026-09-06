import type { DelegatedToolSpec } from '@capiro/meriv2-core';
import { meriCapabilitiesForSurface } from '@capiro/shared';

/** Derived from the authoritative capability registry; surfaces are explicit. */
export const FULL_CHAT_READ_TOOLS: readonly DelegatedToolSpec[] = meriCapabilitiesForSurface(
  'full_chat',
)
  .filter((tool) => tool.readOnly && !tool.surfaces.includes('in_editor'))
  .map(({ name, description, readOnly }) => ({ name, description, readOnly }));
