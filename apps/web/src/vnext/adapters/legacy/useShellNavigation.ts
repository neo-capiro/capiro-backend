import { useMemo } from 'react';
import { useMe } from '../../../lib/me.js';
import { useIntelFeatureFlags } from '../../../lib/intel-feature-flags.js';
import {
  VNEXT_ROUTE_MANIFEST,
  visibleVNextRoutes,
  type VNextRouteDefinition,
} from '../routes/routeManifest.js';

export interface ShellNavigationViewModel {
  /** Primary sidebar entries, in Figma order, already feature-gated. */
  primary: VNextRouteDefinition[];
  /** Footer entry (`722:2581`), kept out of the primary list per Figma. */
  settings: VNextRouteDefinition | null;
  loading: boolean;
}

/**
 * Sidebar navigation model. Route registration stays in `App.tsx`; this adapter
 * only applies the same deny-by-default gating the canonical shell uses, so a
 * user never sees an entry they cannot open.
 */
export function useShellNavigation(): ShellNavigationViewModel {
  const me = useMe();
  const flags = useIntelFeatureFlags();

  return useMemo(() => {
    const visible = visibleVNextRoutes(VNEXT_ROUTE_MANIFEST, {
      featureFlags: flags.data,
      meFeatures: me.data?.features,
    });

    return {
      primary: visible.filter((route) => route.id !== 'settings'),
      settings: visible.find((route) => route.id === 'settings') ?? null,
      loading: me.isLoading || flags.isLoading,
    };
  }, [flags.data, flags.isLoading, me.data?.features, me.isLoading]);
}
