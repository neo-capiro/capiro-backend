import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { OutreachV3SessionEnvelope, OutreachV3StyleSample } from './contracts.js';
import { StyleSamplesSurface } from './StyleSamplesSurface.js';

function session(styleSamples?: OutreachV3StyleSample[]): OutreachV3SessionEnvelope {
  return {
    session: { id: 'session-1', title: 'Ground Robotics', status: 'active' },
    currentStateVersion: 7,
    specHash: 'hash-7',
    pendingProposalCount: 0,
    readiness: { blockers: [] },
    spec: {
      schemaVersion: 'outreach_campaign_spec_v1',
      goal: {
        goal: 'Protect funding',
        objective: 'Educate staff',
        topic: 'Ground Robotics',
        desiredOutcome: 'Request a meeting',
        ask: { mode: 'explicit', text: 'Request a briefing' },
        whyNow: 'Current mark',
      },
      sponsor: { kind: 'firm', label: null, clientRefs: [] },
      targeting: { criteria: null, selectedTargetRefs: [], rejectedRecommendationRefs: [] },
      delivery: { pattern: 'personalized_separate', personalization: 'light' },
      context: {
        requiredPolicyRefs: [],
        writingGuidanceRefs: [],
        campaignFactRefs: [],
        targetSpecificRefs: [],
        groupSafeRefs: [],
        excludedRefs: [],
      },
      strategy: {
        campaignAngle: 'Protect the FY27 line',
        tone: 'Direct',
        length: 'short',
        customLengthInstruction: null,
      },
      // Absent, not `[]`, when there are none — mirrors the server's canonical form.
      ...(styleSamples ? { styleSamples } : {}),
    },
  };
}

function sample(over: Partial<OutreachV3StyleSample> = {}): OutreachV3StyleSample {
  return {
    sampleKey: 'sample:aaa',
    label: 'Approps ask, FY26',
    subject: 'Following up on the directed-energy line',
    body: 'Chairman —\n\nQuick follow-up on the program.\n\nBest,',
    ...over,
  };
}

describe('StyleSamplesSurface', () => {
  it('presents itself as optional and offers a skip when empty', () => {
    const onContinue = vi.fn();
    render(
      <StyleSamplesSurface
        session={session()}
        busy={false}
        applyCommands={vi.fn()}
        onContinue={onContinue}
      />,
    );
    expect(screen.getByText('Optional')).toBeTruthy();
    expect(screen.getByText('No examples yet')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Skip for now' }));
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it('does not submit an example whose body is blank', () => {
    const applyCommands = vi.fn();
    render(
      <StyleSamplesSurface session={session()} busy={false} applyCommands={applyCommands} />,
    );
    // A label alone is not an example — the body is the exemplar.
    fireEvent.change(screen.getByLabelText(/^Label$/), { target: { value: 'Just a name' } });
    expect(screen.getByRole('button', { name: /Add example/ })).toHaveProperty('disabled', true);
    expect(applyCommands).not.toHaveBeenCalled();
  });

  it('sends ADD_STYLE_SAMPLES without a client-asserted sampleKey', async () => {
    const applyCommands = vi.fn().mockResolvedValue({ status: 'applied' });
    render(
      <StyleSamplesSurface session={session()} busy={false} applyCommands={applyCommands} />,
    );
    fireEvent.change(screen.getByLabelText(/Email body/), {
      target: { value: 'Chairman —\n\nA real past email.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Add example/ }));

    await waitFor(() => expect(applyCommands).toHaveBeenCalledTimes(1));
    const [commands] = applyCommands.mock.calls[0] as [Array<Record<string, unknown>>];
    expect(commands).toHaveLength(1);
    expect(commands[0]!.type).toBe('ADD_STYLE_SAMPLES');
    const payload = commands[0]!.payload as { samples: Array<Record<string, unknown>> };
    expect(payload.samples[0]!.body).toBe('Chairman —\n\nA real past email.');
    // The key is derived server-side; sending one would be an unverifiable claim.
    expect(payload.samples[0]).not.toHaveProperty('sampleKey');
    // Empty optional fields go as null, not ''.
    expect(payload.samples[0]!.label).toBeNull();
    expect(payload.samples[0]!.subject).toBeNull();
  });

  it('removes by the server-derived key', async () => {
    const applyCommands = vi.fn().mockResolvedValue({ status: 'applied' });
    render(
      <StyleSamplesSurface
        session={session([sample({ sampleKey: 'sample:zzz' })])}
        busy={false}
        applyCommands={applyCommands}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Remove example 1' }));
    await waitFor(() => expect(applyCommands).toHaveBeenCalledTimes(1));
    const [commands] = applyCommands.mock.calls[0] as [Array<Record<string, unknown>>];
    expect(commands[0]!.type).toBe('REMOVE_STYLE_SAMPLES');
    expect(commands[0]!.payload).toEqual({ sampleKeys: ['sample:zzz'] });
  });

  it('shows only a single-line preview, never the whole pasted email', () => {
    const body = `First line of the email\n${'Sensitive middle paragraph. '.repeat(20)}`;
    render(
      <StyleSamplesSurface
        session={session([sample({ body })])}
        busy={false}
        applyCommands={vi.fn()}
      />,
    );
    expect(screen.getByText('First line of the email')).toBeTruthy();
    expect(screen.queryByText(/Sensitive middle paragraph/)).toBeNull();
  });

  it('states that examples never become facts', () => {
    render(
      <StyleSamplesSurface
        session={session([sample()])}
        busy={false}
        applyCommands={vi.fn()}
      />,
    );
    expect(screen.getByText('Voice only — never facts')).toBeTruthy();
    expect(screen.getByText('Nothing is carried across as fact')).toBeTruthy();
  });

  it('stops offering the form at the bounded maximum instead of failing on submit', () => {
    const samples = Array.from({ length: 5 }, (_, index) =>
      sample({ sampleKey: `sample:${index}`, label: `Example ${index}` }),
    );
    render(
      <StyleSamplesSurface session={session(samples)} busy={false} applyCommands={vi.fn()} />,
    );
    expect(screen.getByText('5 examples is the maximum')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Add example/ })).toBeNull();
  });

  it('surfaces a rejected add without clearing what the user typed', async () => {
    const applyCommands = vi
      .fn()
      .mockRejectedValue({ response: { data: { message: 'Too many example emails.' } } });
    render(
      <StyleSamplesSurface session={session()} busy={false} applyCommands={applyCommands} />,
    );
    const body = screen.getByLabelText(/Email body/) as HTMLTextAreaElement;
    fireEvent.change(body, { target: { value: 'Draft the user does not want to lose.' } });
    fireEvent.click(screen.getByRole('button', { name: /Add example/ }));

    await waitFor(() => expect(screen.getByText('Too many example emails.')).toBeTruthy());
    expect(body.value).toBe('Draft the user does not want to lose.');
  });
});
