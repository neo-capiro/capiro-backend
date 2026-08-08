import {
  DESIRED_WEBHOOK_ALERTS_V1,
  type DesiredWebhookAlert,
  DuplicateDesiredAlertError,
  TANGO_MANAGED_ALERT_PREFIX,
} from '../src/external/tango/tango-webhook-config.js';
import type {
  TangoGateway,
  TangoWebhookAlert,
  TangoWebhookEndpoint,
} from '../src/external/tango/tango.types.js';
import {
  EXIT_BAD_ARGS,
  EXIT_DRIFT,
  EXIT_ENDPOINT_UNRESOLVED,
  EXIT_OK,
  EXIT_TIER_DENIED,
  isTierDenied,
  parseArgs,
  reconcile,
  resolveEndpoint,
  validateArgs,
} from './reconcile-tango-webhook-alerts.js';

/**
 * Funding Opportunities P47 — webhook alert reconciler.
 *
 * The gateway is a RECORDING fake, not a mock: the single most important claim
 * this phase makes is "a dry run performs no write", and the only way to prove
 * that is to assert on the complete list of calls actually issued. A per-call
 * mock would let a stray write slip through unasserted.
 *
 * No test here reaches the network, and no real key is read.
 */

const CALLBACK = 'https://api.dev.capiro.ai/webhooks/tango';

class GatewayFake {
  configured = true;
  lastRate = null;
  readonly calls: string[] = [];
  endpoints: TangoWebhookEndpoint[] = [
    { id: 'ep-1', name: 'capiro', callbackUrl: CALLBACK, isActive: true },
  ];
  alerts: TangoWebhookAlert[] = [];
  /** Set to throw from the next write, to simulate a tier refusal. */
  writeError: unknown = null;
  /** Set to throw from reads. */
  readError: unknown = null;

  async listWebhookEndpoints(): Promise<TangoWebhookEndpoint[]> {
    this.calls.push('listWebhookEndpoints');
    if (this.readError) throw this.readError;
    return this.endpoints;
  }

  async listWebhookAlerts(): Promise<TangoWebhookAlert[]> {
    this.calls.push('listWebhookAlerts');
    if (this.readError) throw this.readError;
    return this.alerts;
  }

  async createWebhookAlert(input: { name: string; queryType: string }): Promise<TangoWebhookAlert> {
    this.calls.push(`createWebhookAlert:${input.name}`);
    if (this.writeError) throw this.writeError;
    const created: TangoWebhookAlert = {
      alertId: `a-${this.alerts.length + 1}`,
      name: input.name,
      queryType: input.queryType,
      filters: {},
      frequency: 'realtime',
      status: 'active',
    };
    this.alerts.push(created);
    return created;
  }

  async deleteWebhookAlert(alertId: string): Promise<void> {
    this.calls.push(`deleteWebhookAlert:${alertId}`);
    if (this.writeError) throw this.writeError;
    this.alerts = this.alerts.filter((a) => a.alertId !== alertId);
  }

  /** Every write this fake can perform, for the no-write assertion. */
  get writeCalls(): string[] {
    return this.calls.filter((c) => c.startsWith('create') || c.startsWith('delete'));
  }
}

function gw(fake: GatewayFake): TangoGateway {
  return fake as unknown as TangoGateway;
}

const dryRun = parseArgs([]);
const commitArgs = parseArgs(['--commit', '--endpoint-id=ep-1', `--confirm-callback=${CALLBACK}`]);

describe('parseArgs', () => {
  it('defaults to a dry run with no deletion', () => {
    expect(parseArgs([])).toEqual({
      commit: false,
      allowDelete: false,
      endpointId: null,
      confirmCallback: null,
      json: false,
    });
  });

  it('reads the commit flags', () => {
    const a = parseArgs([
      '--commit',
      '--allow-delete',
      '--endpoint-id=ep-9',
      '--confirm-callback=https://x',
    ]);
    expect(a).toMatchObject({
      commit: true,
      allowDelete: true,
      endpointId: 'ep-9',
      confirmCallback: 'https://x',
    });
  });

  it('does not treat --commit-something as --commit', () => {
    expect(parseArgs(['--commit-nothing']).commit).toBe(false);
  });
});

describe('validateArgs', () => {
  it('accepts a bare dry run', () => {
    expect(validateArgs(parseArgs([])).ok).toBe(true);
  });

  it('accepts --allow-delete WITHOUT --commit (the recommended preview)', () => {
    expect(validateArgs(parseArgs(['--allow-delete'])).ok).toBe(true);
  });

  it('refuses --commit with no endpoint id', () => {
    const r = validateArgs(parseArgs(['--commit']));
    expect(r.ok).toBe(false);
    expect((r as { message: string }).message).toContain('--endpoint-id');
  });

  it('refuses --commit with no callback confirmation', () => {
    const r = validateArgs(parseArgs(['--commit', '--endpoint-id=ep-1']));
    expect(r.ok).toBe(false);
    expect((r as { message: string }).message).toContain('--confirm-callback');
  });
});

describe('isTierDenied', () => {
  it.each([
    ['kind=tier', { kind: 'tier' }],
    ['kind=auth', { kind: 'auth' }],
    ['HTTP 403', { status: 403 }],
    ['HTTP 402', { status: 402 }],
    ['a message naming the plan tier', new Error('Webhook writes require the Enterprise tier')],
    ['a message saying not permitted', new Error('Operation not permitted for this plan')],
  ])('classifies %s as tier-denied', (_label, err) => {
    expect(isTierDenied(err)).toBe(true);
  });

  it.each([
    ['a timeout', new Error('socket hang up')],
    ['a 500', { status: 500 }],
    ['null', null],
  ])('does NOT classify %s as tier-denied', (_label, err) => {
    expect(isTierDenied(err)).toBe(false);
  });
});

describe('resolveEndpoint', () => {
  const a: TangoWebhookEndpoint = { id: 'ep-1', name: 'a', callbackUrl: CALLBACK, isActive: true };
  const b: TangoWebhookEndpoint = { id: 'ep-2', name: 'b', callbackUrl: CALLBACK, isActive: true };

  it('auto-resolves a single endpoint', () => {
    expect(resolveEndpoint([a], null)).toEqual({ ok: true, endpoint: a });
  });

  it('REFUSES to guess between several', () => {
    const r = resolveEndpoint([a, b], null);
    expect(r.ok).toBe(false);
    expect((r as { message: string }).message).toContain('--endpoint-id');
  });

  it('honours an explicit id', () => {
    expect(resolveEndpoint([a, b], 'ep-2')).toEqual({ ok: true, endpoint: b });
  });

  it('fails clearly on an unknown id rather than falling back', () => {
    const r = resolveEndpoint([a], 'ep-missing');
    expect(r.ok).toBe(false);
    expect((r as { message: string }).message).toContain('not found');
  });

  it('reports no endpoint as a resolvable absence, not an error', () => {
    expect(resolveEndpoint([], null)).toEqual({ ok: true, endpoint: null });
  });
});

describe('reconcile — dry run', () => {
  it('PERFORMS NO WRITE, and issues only reads', async () => {
    const fake = new GatewayFake();
    const outcome = await reconcile(gw(fake), dryRun);

    expect(fake.writeCalls).toEqual([]);
    expect(fake.calls).toEqual(['listWebhookEndpoints', 'listWebhookAlerts']);
    expect(outcome.exitCode).toBe(EXIT_DRIFT);
    expect(outcome.lines.join('\n')).toContain('DRY RUN — nothing was written');
  });

  it('reports no work — and exit 0 — when desired state already matches', async () => {
    const fake = new GatewayFake();
    fake.alerts = DESIRED_WEBHOOK_ALERTS_V1.map((d, i) => ({
      alertId: `a-${i}`,
      name: d.name,
      queryType: d.queryType,
      filters: {},
      frequency: 'realtime',
      status: 'active' as const,
    }));

    const outcome = await reconcile(gw(fake), dryRun);
    expect(outcome.exitCode).toBe(EXIT_OK);
    expect(fake.writeCalls).toEqual([]);
  });

  it('warns when the endpoint exists but is INACTIVE', async () => {
    const fake = new GatewayFake();
    fake.endpoints = [{ id: 'ep-1', name: 'a', callbackUrl: CALLBACK, isActive: false }];
    const outcome = await reconcile(gw(fake), dryRun);
    expect(outcome.lines.join('\n')).toContain('INACTIVE');
  });

  it('never proposes deleting an unmanaged alert', async () => {
    const fake = new GatewayFake();
    fake.alerts = [
      {
        alertId: 'h-1',
        name: 'someones-dashboard-alert',
        queryType: 'contract',
        filters: {},
        frequency: 'daily',
        status: 'active',
      },
    ];
    const outcome = await reconcile(gw(fake), parseArgs(['--allow-delete']));
    expect(outcome.lines.join('\n')).toContain('IGNORED');
    expect(fake.writeCalls).toEqual([]);
  });
});

describe('reconcile — tier refusal', () => {
  const tierErr = Object.assign(new Error('Webhook writes require Enterprise'), { kind: 'tier' });

  it('exits 3 with an actionable message when READS are refused', async () => {
    const fake = new GatewayFake();
    fake.readError = tierErr;
    const outcome = await reconcile(gw(fake), dryRun);
    expect(outcome.exitCode).toBe(EXIT_TIER_DENIED);
    expect(outcome.lines.join('\n')).toContain('Nothing was created');
  });

  it('exits 3 and STOPS on a refused write — never leaves a half-configured account', async () => {
    // P47 acceptance: "unsupported tier exits with an actionable nonzero
    // result, not partial configuration."
    const fake = new GatewayFake();
    fake.writeError = tierErr;

    const outcome = await reconcile(gw(fake), commitArgs);

    expect(outcome.exitCode).toBe(EXIT_TIER_DENIED);
    // It attempted exactly ONE write and then stopped, rather than marching
    // through the rest of the desired set collecting failures.
    expect(fake.writeCalls).toHaveLength(1);
    expect(outcome.lines.join('\n')).toContain('half-configured');
    // And it names the now-resolved discrepancy rather than restating it as open.
    expect(outcome.lines.join('\n')).toContain('does NOT permit it');
  });

  it('rethrows a NON-tier error rather than misreporting it as a tier problem', async () => {
    const fake = new GatewayFake();
    fake.readError = new Error('socket hang up');
    await expect(reconcile(gw(fake), dryRun)).rejects.toThrow('socket hang up');
  });
});

describe('reconcile — commit', () => {
  it('creates the missing alerts against the confirmed endpoint', async () => {
    const fake = new GatewayFake();
    const outcome = await reconcile(gw(fake), commitArgs);

    expect(outcome.exitCode).toBe(EXIT_OK);
    expect(fake.writeCalls).toHaveLength(DESIRED_WEBHOOK_ALERTS_V1.length);
    for (const d of DESIRED_WEBHOOK_ALERTS_V1) {
      expect(fake.calls).toContain(`createWebhookAlert:${d.name}`);
    }
  });

  it('a re-run after commit is a NO-OP', async () => {
    const fake = new GatewayFake();
    await reconcile(gw(fake), commitArgs);
    const before = fake.writeCalls.length;

    const second = await reconcile(gw(fake), dryRun);
    expect(second.exitCode).toBe(EXIT_OK);
    expect(fake.writeCalls).toHaveLength(before);
  });

  it('REFUSES to commit when the confirmed callback disagrees with the provider', async () => {
    const fake = new GatewayFake();
    const outcome = await reconcile(
      gw(fake),
      parseArgs(['--commit', '--endpoint-id=ep-1', '--confirm-callback=https://evil.example/hook']),
    );

    expect(outcome.exitCode).toBe(EXIT_BAD_ARGS);
    expect(fake.writeCalls).toEqual([]);
    expect(outcome.lines.join('\n')).toContain('does not match');
  });

  it('REFUSES to commit when the account has no endpoint at all', async () => {
    const fake = new GatewayFake();
    fake.endpoints = [];
    const outcome = await reconcile(
      gw(fake),
      parseArgs(['--commit', '--endpoint-id=ep-1', `--confirm-callback=${CALLBACK}`]),
    );
    expect(outcome.exitCode).toBe(EXIT_ENDPOINT_UNRESOLVED);
    expect(fake.writeCalls).toEqual([]);
  });

  it('deletes a managed stray only when --allow-delete is passed', async () => {
    const fake = new GatewayFake();
    await reconcile(gw(fake), commitArgs);
    fake.alerts.push({
      alertId: 'a-stray',
      name: `${TANGO_MANAGED_ALERT_PREFIX}retired`,
      queryType: 'contract',
      filters: {},
      frequency: 'daily',
      status: 'active',
    });

    const withoutFlag = await reconcile(gw(fake), commitArgs);
    expect(withoutFlag.lines.join('\n')).not.toContain('deleted');

    const withFlag = await reconcile(
      gw(fake),
      parseArgs([
        '--commit',
        '--allow-delete',
        '--endpoint-id=ep-1',
        `--confirm-callback=${CALLBACK}`,
      ]),
    );
    expect(fake.calls).toContain('deleteWebhookAlert:a-stray');
    expect(withFlag.exitCode).toBe(EXIT_OK);
  });
});

describe('reconcile — safety rails', () => {
  it('does nothing at all when no API key is configured', async () => {
    const fake = new GatewayFake();
    fake.configured = false;
    const outcome = await reconcile(gw(fake), commitArgs);
    expect(outcome.exitCode).toBe(EXIT_BAD_ARGS);
    expect(fake.calls).toEqual([]);
  });

  it('rejects a duplicate desired set BEFORE issuing any call', async () => {
    const fake = new GatewayFake();
    const dupe: DesiredWebhookAlert[] = [
      { key: 'a', name: 'capiro-managed/x', queryType: 'contract', filters: {}, rationale: '' },
      { key: 'b', name: 'capiro-managed/x', queryType: 'contract', filters: {}, rationale: '' },
    ];
    await expect(reconcile(gw(fake), commitArgs, dupe)).rejects.toThrow(DuplicateDesiredAlertError);
    expect(fake.calls).toEqual([]);
  });

  it('never prints a signing secret, even if the provider returns one', async () => {
    const fake = new GatewayFake();
    fake.endpoints = [
      {
        id: 'ep-1',
        name: 'a',
        callbackUrl: CALLBACK,
        isActive: true,
        secret: 'whsec_super_secret_value',
      },
    ];
    const outcome = await reconcile(gw(fake), commitArgs);
    expect(outcome.lines.join('\n')).not.toContain('whsec_super_secret_value');
  });
});
