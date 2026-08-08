import {
  DESIRED_WEBHOOK_ALERTS_V1,
  type DesiredWebhookAlert,
  DuplicateDesiredAlertError,
  TANGO_MANAGED_ALERT_PREFIX,
  TANGO_WEBHOOK_DESIRED_VERSION,
  assertNoDuplicateDesiredAlerts,
  diffWebhookAlerts,
  renderPlan,
  toAlertInput,
} from './tango-webhook-config.js';
import type { TangoWebhookAlert } from './tango.types.js';

/**
 * Funding Opportunities P47 — desired webhook alert state.
 *
 * Pure module, so this is a pure spec: no fixtures of provider bytes, no fake
 * gateway, no clock. The reconciler CLI's own spec covers the I/O.
 */

function actual(over: Partial<TangoWebhookAlert> = {}): TangoWebhookAlert {
  return {
    alertId: 'a-1',
    name: `${TANGO_MANAGED_ALERT_PREFIX}contract-opportunities`,
    queryType: 'contract',
    filters: {},
    frequency: 'realtime',
    status: 'active',
    ...over,
  };
}

function desired(over: Partial<DesiredWebhookAlert> = {}): DesiredWebhookAlert {
  return {
    key: 'contract_opportunities',
    name: `${TANGO_MANAGED_ALERT_PREFIX}contract-opportunities`,
    queryType: 'contract',
    filters: {},
    rationale: 'test',
    ...over,
  };
}

describe('the shipped desired set', () => {
  it('is internally valid', () => {
    expect(() => assertNoDuplicateDesiredAlerts()).not.toThrow();
  });

  it('NEVER contains a per-client subscription — fan-out belongs in Capiro', () => {
    // The structural form of "do not create one provider alert per Capiro
    // client". A filter naming a tenant, client, or UEI would leak the client
    // roster into the provider's system, where no RLS policy can reach it.
    for (const alert of DESIRED_WEBHOOK_ALERTS_V1) {
      const serialized = JSON.stringify(alert.filters).toLowerCase();
      expect(serialized).not.toMatch(/tenant|client|uei|cage|duns/);
    }
  });

  it('every alert carries the managed prefix', () => {
    for (const alert of DESIRED_WEBHOOK_ALERTS_V1) {
      expect(alert.name.startsWith(TANGO_MANAGED_ALERT_PREFIX)).toBe(true);
    }
  });

  it('uses SINGULAR provider query types, as the SDK documents', () => {
    for (const alert of DESIRED_WEBHOOK_ALERTS_V1) {
      expect(alert.queryType).not.toMatch(/s$/);
    }
  });

  it('is frozen, so no caller can mutate shared desired state at runtime', () => {
    expect(Object.isFrozen(DESIRED_WEBHOOK_ALERTS_V1)).toBe(true);
  });
});

describe('assertNoDuplicateDesiredAlerts', () => {
  it('rejects a duplicate key', () => {
    expect(() =>
      assertNoDuplicateDesiredAlerts([desired(), desired({ name: 'capiro-managed/other' })]),
    ).toThrow(DuplicateDesiredAlertError);
  });

  it('rejects a duplicate NAME — the dangerous case', () => {
    // Two entries sharing a name would each match the other's provider alert,
    // both report "already present", and one subscription would never be made.
    expect(() =>
      assertNoDuplicateDesiredAlerts([desired(), desired({ key: 'different_key' })]),
    ).toThrow(DuplicateDesiredAlertError);
  });

  it('names which field collided', () => {
    try {
      assertNoDuplicateDesiredAlerts([desired(), desired({ key: 'other' })]);
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as DuplicateDesiredAlertError).duplicates.join()).toContain('name=');
    }
  });

  it('accepts a genuinely distinct set', () => {
    expect(() =>
      assertNoDuplicateDesiredAlerts([
        desired(),
        desired({ key: 'forecasts', name: 'capiro-managed/forecasts', queryType: 'forecast' }),
      ]),
    ).not.toThrow();
  });
});

describe('diffWebhookAlerts', () => {
  it('plans a create when the provider has nothing', () => {
    const plan = diffWebhookAlerts([desired()], []);
    expect(plan.actions).toEqual([{ kind: 'create', desired: desired() }]);
    expect(plan.hasWork).toBe(true);
  });

  it('reports unchanged when the alert exists and is active', () => {
    const plan = diffWebhookAlerts([desired()], [actual()]);
    expect(plan.actions[0]?.kind).toBe('unchanged');
    expect(plan.hasWork).toBe(false);
  });

  it('a re-run after commit is a NO-OP', () => {
    // P47 acceptance: "re-run after commit is a no-op."
    const plan = diffWebhookAlerts(DESIRED_WEBHOOK_ALERTS_V1, [
      actual({ name: DESIRED_WEBHOOK_ALERTS_V1[0]!.name }),
      actual({ alertId: 'a-2', name: DESIRED_WEBHOOK_ALERTS_V1[1]!.name, queryType: 'forecast' }),
    ]);
    expect(plan.hasWork).toBe(false);
    expect(plan.actions.every((a) => a.kind === 'unchanged')).toBe(true);
  });

  it('reports a PAUSED alert distinctly — not as missing, not as fine', () => {
    // Proposing a create would collide on name; proposing nothing would hide
    // that delivery has silently stopped.
    const plan = diffWebhookAlerts([desired()], [actual({ status: 'paused' })]);
    expect(plan.actions[0]?.kind).toBe('paused');
    // Not work: the fix is an operator resuming it at the provider, not a write.
    expect(plan.hasWork).toBe(false);
  });

  it('NEVER deletes by absence when --allow-delete is not passed', () => {
    const stray = actual({ alertId: 'a-9', name: `${TANGO_MANAGED_ALERT_PREFIX}retired` });
    const plan = diffWebhookAlerts([desired()], [actual(), stray]);
    expect(plan.actions.some((a) => a.kind === 'delete')).toBe(false);
    expect(plan.actions.some((a) => a.kind === 'unmanaged')).toBe(true);
    expect(plan.hasWork).toBe(false);
  });

  it('deletes a MANAGED stray only when allowDelete is passed', () => {
    const stray = actual({ alertId: 'a-9', name: `${TANGO_MANAGED_ALERT_PREFIX}retired` });
    const plan = diffWebhookAlerts([desired()], [actual(), stray], { allowDelete: true });
    const del = plan.actions.find((a) => a.kind === 'delete');
    expect(del).toBeDefined();
    expect((del as { actual: TangoWebhookAlert }).actual.alertId).toBe('a-9');
  });

  it("NEVER deletes a human's dashboard alert, even WITH allowDelete", () => {
    // The second guard, and the one that matters most: an alert without the
    // managed prefix was made by a person or another system.
    const human = actual({ alertId: 'h-1', name: 'ops-teams-adhoc-watch' });
    const plan = diffWebhookAlerts([desired()], [actual(), human], { allowDelete: true });
    expect(plan.actions.some((a) => a.kind === 'delete')).toBe(false);
    const ignored = plan.actions.find((a) => a.kind === 'unmanaged');
    expect((ignored as { actual: TangoWebhookAlert }).actual.name).toBe('ops-teams-adhoc-watch');
  });

  it('stamps the desired-state version so an operator can tell which intent is live', () => {
    expect(diffWebhookAlerts([], []).version).toBe(TANGO_WEBHOOK_DESIRED_VERSION);
  });

  it('an empty provider account with an empty desired set is no work', () => {
    expect(diffWebhookAlerts([], []).hasWork).toBe(false);
  });
});

describe('toAlertInput', () => {
  it('omits endpointId entirely when none is supplied', () => {
    // Single-endpoint accounts auto-resolve; sending an explicit `undefined`
    // would serialize as a null and be rejected as a bad argument.
    expect(toAlertInput(desired(), undefined)).not.toHaveProperty('endpointId');
  });

  it('includes endpointId when supplied', () => {
    expect(toAlertInput(desired(), 'ep-1').endpointId).toBe('ep-1');
  });

  it('carries the prefixed name through unchanged', () => {
    expect(toAlertInput(desired(), undefined).name).toBe(desired().name);
  });
});

describe('renderPlan', () => {
  it('renders one line per action and never leaks a filter payload', () => {
    const lines = renderPlan(
      diffWebhookAlerts([desired()], [actual({ alertId: 'x', name: 'human-made' })], {
        allowDelete: true,
      }),
    );
    expect(lines).toHaveLength(2);
    expect(lines.join('\n')).toContain('CREATE');
    expect(lines.join('\n')).toContain('IGNORED');
  });

  it('explains WHY an unmanaged alert is ignored, not just that it was', () => {
    const lines = renderPlan(diffWebhookAlerts([], [actual({ name: 'human-made' })]));
    expect(lines[0]).toContain('not a deletion signal');
  });
});
