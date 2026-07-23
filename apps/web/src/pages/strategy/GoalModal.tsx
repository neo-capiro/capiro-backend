/*
 * Create-a-strategy modal (CRT) — ported from the prototype sp-landing.jsx
 * GoalModal. MANUAL create: the "Start from a document" uploader and the
 * "Draft with Meri" progress takeover are deferred to G5 (AI). The type picker
 * is rendered per plan D5 (the prototype defined OBJECTIVE_TYPES but never
 * showed a picker). The CRT-6 owner picker is a searchable org-member dropdown
 * (OwnerPicker) defaulting to the current user.
 */
import { useState } from 'react';
import { App as AntApp } from 'antd';
import { useUser } from '@clerk/clerk-react';
import { Overlay, Icon, btnPrimary, btnGhost, iconBtn, lbl } from './strategy-ui.js';
import { OwnerPicker } from './OwnerPicker.js';
import { OBJECTIVE_TYPES } from './constants.js';
import { useCreateStrategy } from './api.js';
import { useTenantMembers } from './members.js';
import type { ClientLite } from './clients-lite.js';
import type { StrategyType } from './types.js';

export function GoalModal({
  clients,
  onClose,
  onCreated,
}: {
  clients: ClientLite[];
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const { user } = useUser();
  const { message } = AntApp.useApp();
  const create = useCreateStrategy();
  const members = useTenantMembers();

  const [type, setType] = useState<StrategyType>('appropriations');
  const [client, setClient] = useState('');
  const [goal, setGoal] = useState('');
  const [deadline, setDeadline] = useState('');
  const [context, setContext] = useState('');
  const [owner, setOwner] = useState<string | null>(null);
  const effectiveOwner = owner ?? user?.id ?? null;

  const submit = async () => {
    if (!client) return;
    try {
      const created = await create.mutateAsync({
        clientId: client,
        type,
        goal: goal.trim() || undefined,
        ownerUserId: effectiveOwner ?? undefined,
        targetDate: deadline || undefined,
        meriContext: context.trim() || undefined,
      });
      onCreated(created.id);
    } catch {
      message.error('Could not create the strategy. Please try again.');
    }
  };

  const field: React.CSSProperties = {
    width: '100%',
    border: '1px solid var(--border-2)',
    borderRadius: 9,
    padding: '9px 13px',
    fontSize: 'var(--text-base)',
    fontFamily: 'var(--font-sans)',
    color: 'var(--ink-1)',
    background: 'var(--bg-surface)',
    boxSizing: 'border-box',
  };

  return (
    <Overlay onClose={onClose}>
      <div
        style={{
          width: 580,
          background: 'var(--bg-surface)',
          borderRadius: 14,
          overflow: 'hidden',
          boxShadow: '0 24px 60px rgba(12,26,56,0.28)',
        }}
      >
        <div
          style={{
            padding: '18px 24px',
            borderBottom: '1px solid var(--border-1)',
            display: 'flex',
            alignItems: 'center',
          }}
        >
          <div>
            <div
              style={{
                fontSize: 'var(--text-2xs)',
                fontFamily: 'var(--font-mono)',
                color: 'var(--ink-4)',
                fontWeight: 600,
              }}
            >
              NEW STRATEGY
            </div>
            <div
              style={{
                fontSize: 'var(--text-lg)',
                fontWeight: 700,
                color: 'var(--ink-1)',
                marginTop: 2,
              }}
            >
              What are you trying to achieve?
            </div>
          </div>
          <div style={{ flex: 1 }} />
          <button onClick={onClose} style={iconBtn}>
            <Icon name="x" size={16} color="var(--ink-3)" />
          </button>
        </div>

        <div style={{ padding: '20px 24px' }}>
          <label style={lbl}>
            Client <span style={{ color: 'var(--critical)', fontWeight: 700 }}>*</span>
          </label>
          <select
            value={client}
            onChange={(e) => setClient(e.target.value)}
            style={{
              ...field,
              border: client ? '1px solid var(--border-2)' : '1px solid var(--critical)',
              color: client ? 'var(--ink-1)' : 'var(--ink-3)',
              marginBottom: 18,
            }}
          >
            <option value="">Select a client…</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>

          <label style={lbl}>Objective type</label>
          <select
            value={type}
            onChange={(e) => setType(e.target.value as StrategyType)}
            style={{ ...field, marginBottom: 4 }}
          >
            {OBJECTIVE_TYPES.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
          <div
            style={{
              fontSize: 'var(--text-xs)',
              color: 'var(--ink-3)',
              marginBottom: 18,
              lineHeight: 1.4,
            }}
          >
            {OBJECTIVE_TYPES.find((t) => t.id === type)?.desc}
          </div>

          <label style={lbl}>Goal statement</label>
          <textarea
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            rows={2}
            placeholder="e.g. Secure a $14M FY27 HAC-D plus-up for the compliance program and authorize it in the NDAA."
            style={{ ...field, resize: 'none', lineHeight: 1.5 }}
          />

          <div style={{ display: 'flex', gap: 14, marginTop: 18 }}>
            <div style={{ flex: 1 }}>
              <label style={lbl}>Owner</label>
              <OwnerPicker members={members.data ?? []} value={effectiveOwner} onChange={setOwner} />
            </div>
            <div style={{ flex: 1 }}>
              <label style={lbl}>
                Target outcome date{' '}
                <span
                  style={{
                    fontWeight: 400,
                    textTransform: 'none',
                    letterSpacing: 0,
                    color: 'var(--ink-3)',
                  }}
                >
                  · optional
                </span>
              </label>
              <input
                type="date"
                value={deadline}
                onChange={(e) => setDeadline(e.target.value)}
                style={field}
              />
            </div>
          </div>

          <label style={{ ...lbl, marginTop: 18 }}>
            Context for Meri{' '}
            <span
              style={{
                fontWeight: 400,
                textTransform: 'none',
                letterSpacing: 0,
                color: 'var(--ink-3)',
              }}
            >
              · optional
            </span>
          </label>
          <textarea
            value={context}
            onChange={(e) => setContext(e.target.value)}
            rows={2}
            placeholder="Key players, constraints, prior history, sensitivities — anything that should shape the plan."
            style={{ ...field, resize: 'none', lineHeight: 1.5 }}
          />

          <div
            style={{
              marginTop: 16,
              display: 'flex',
              alignItems: 'center',
              gap: 9,
              background: 'var(--bg-surface-2)',
              border: '1px solid var(--border-1)',
              borderRadius: 9,
              padding: '10px 13px',
            }}
          >
            <Icon name="spark" size={15} color="var(--accent)" />
            <span style={{ fontSize: 'var(--text-sm)', color: 'var(--ink-2)' }}>
              Start with an empty timeline and add steps. Meri drafting and document import arrive
              soon.
            </span>
          </div>
        </div>

        <div
          style={{
            padding: '14px 24px',
            borderTop: '1px solid var(--border-1)',
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 10,
            background: 'var(--bg-surface-2)',
          }}
        >
          <button onClick={onClose} style={btnGhost}>
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={!client || create.isPending}
            title={client ? '' : 'Select a client first'}
            style={{
              ...btnPrimary,
              opacity: !client || create.isPending ? 0.45 : 1,
              cursor: !client || create.isPending ? 'not-allowed' : 'pointer',
            }}
          >
            {create.isPending ? 'Creating…' : 'Create strategy'}
            {!create.isPending && <Icon name="arrow" size={14} color="#fff" />}
          </button>
        </div>
      </div>
    </Overlay>
  );
}
