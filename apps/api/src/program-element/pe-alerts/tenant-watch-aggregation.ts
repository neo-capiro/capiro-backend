export interface PeAlertWatchRow {
  userId: string;
  tenantId: string;
  peCode: string;
  email: string;
}

export interface PeAlertPreferenceRow {
  userId: string;
  tenantId: string;
  mode: string;
}

export interface PeAlertCanary {
  all: boolean;
  ids: ReadonlySet<string>;
}

export interface TenantScopedPeAlertAggregate {
  key: string;
  userId: string;
  tenantId: string;
  email: string;
  watched: Set<string>;
  mode: string;
  enabled: boolean;
  canaryEligible: boolean;
}

/**
 * Build one digest audience per tenant+user. The same user and PE in two tenants
 * must remain two independent aggregates, preferences and canary decisions.
 */
export function aggregateTenantScopedPeAlertWatches(
  watches: readonly PeAlertWatchRow[],
  preferences: readonly PeAlertPreferenceRow[],
  canary: PeAlertCanary,
): TenantScopedPeAlertAggregate[] {
  const modeByKey = new Map<string, string>(
    preferences.map((pref) => [`${pref.tenantId}:${pref.userId}`, pref.mode]),
  );
  const aggregates = new Map<
    string,
    Omit<TenantScopedPeAlertAggregate, 'mode' | 'enabled' | 'canaryEligible'>
  >();

  for (const watch of watches) {
    const key = `${watch.tenantId}:${watch.userId}`;
    const aggregate = aggregates.get(key) ?? {
      key,
      userId: watch.userId,
      tenantId: watch.tenantId,
      email: watch.email,
      watched: new Set<string>(),
    };
    aggregate.watched.add(watch.peCode);
    aggregates.set(key, aggregate);
  }

  return [...aggregates.values()]
    .map((aggregate) => {
      const mode = modeByKey.get(aggregate.key) ?? 'daily';
      return {
        ...aggregate,
        mode,
        enabled: mode !== 'off',
        canaryEligible: canary.all || canary.ids.has(aggregate.tenantId),
      };
    })
    .sort((a, b) => a.key.localeCompare(b.key));
}
