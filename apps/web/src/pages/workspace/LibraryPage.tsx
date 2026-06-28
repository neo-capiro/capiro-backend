import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { App as AntApp, Spin } from 'antd';
import { Icon, Kicker, MeriBtn } from './kit.js';
import { useIndustries, useProductsFor, useCreateDraft, useMeriIntake } from './api.js';
import { WsTabs } from './WsTabs.js';

/**
 * Workspace Library — the landing experience, ported to full fidelity from the
 * locked prototype (WsLibrary). Two ways to start: describe it to Meri (auto-
 * drafts and opens the editor, Q-LIB-3), or pick a work-product card (→ Setup).
 */

/** Per-product icon (lucide) + one-line description — mirrors the engine PRODUCT_META. */
const PRODUCT_META: Record<string, { icon: string; desc: string }> = {
  'White paper': {
    icon: 'FileText',
    desc: 'Narrative program paper supporting authorization, appropriations, or policy asks.',
  },
  'Appropriations Justification': {
    icon: 'Coins',
    desc: "Detail a program's funding need and justification.",
  },
  'NDAA Authorization Request': {
    icon: 'TrendingUp',
    desc: 'Request program authorization or a budget adjustment.',
  },
  'Meeting Brief & Advocacy': {
    icon: 'Users',
    desc: 'Leave-behind brief for a member or staff meeting.',
  },
  'CDS / Earmark Application': { icon: 'Landmark', desc: 'Community project funding application.' },
  'Authorization Bill Language': {
    icon: 'Scale',
    desc: 'Amendatory statutory / authorizing text.',
  },
  'Report Language Request': {
    icon: 'FileSignature',
    desc: 'Directive or encouraging committee report language.',
  },
  'Member letter': {
    icon: 'Mail',
    desc: 'Cosponsor request, support letter, or consolidated sign-on letter to a Member.',
  },
  'Strategy memo': {
    icon: 'ClipboardList',
    desc: 'Internal brief covering situation analysis and strategic recommendation.',
  },
  'Written testimony': {
    icon: 'Mic',
    desc: 'Statement for the record before a committee or agency.',
  },
  'One-pager': {
    icon: 'File',
    desc: 'Meeting leave-behind or fact sheet summarizing the program and ask.',
  },
};

function intakeError(e: unknown): string {
  return (
    (e as { response?: { data?: { message?: string } } })?.response?.data?.message ??
    'Meri could not start the draft. Please try again.'
  );
}

export function LibraryPage() {
  const navigate = useNavigate();
  const { message } = AntApp.useApp();
  const [sector, setSector] = useState<string | null>(null);
  const [prompt, setPrompt] = useState('');
  const [showRequest, setShowRequest] = useState(false);
  const { data: industries } = useIndustries();
  const { data: products, isLoading } = useProductsFor(sector, sector === null);
  const createDraft = useCreateDraft();
  const meriIntake = useMeriIntake();

  const newDocument = async () => {
    try {
      const d = await createDraft.mutateAsync({});
      navigate(`/workspace/setup/${d.id}`);
    } catch {
      message.error('Could not start a new document. Please try again.');
    }
  };

  const startProduct = async (product: string) => {
    try {
      const d = await createDraft.mutateAsync({ industry: sector ?? undefined, product });
      navigate(`/workspace/setup/${d.id}`);
    } catch {
      message.error('Could not start a new document. Please try again.');
    }
  };

  const draftWithMeri = async () => {
    if (!prompt.trim()) {
      message.info('Describe what you need so Meri can draft it.');
      return;
    }
    try {
      // Meri resolves the work product + seeds the draft, then we route to the
      // Context Builder. Meri drafts the full document AFTER context is built
      // (Context Builder → Open editor), so it grounds on the chosen context.
      const d = await meriIntake.mutateAsync({ prompt: prompt.trim() });
      navigate(`/workspace/context/${d.id}`);
    } catch (e) {
      message.error(intakeError(e));
    }
  };

  const gridProducts = products ?? [];

  return (
    <div className="ws-stage">
      <div style={{ maxWidth: 1180, margin: '0 auto' }}>
        {/* Header */}
        <header
          style={{
            display: 'flex',
            alignItems: 'flex-end',
            justifyContent: 'space-between',
            marginBottom: 16,
          }}
        >
          <div>
            <Kicker style={{ marginBottom: 8 }}>Workspace</Kicker>
            <h1
              style={{
                fontFamily: 'var(--font-serif)',
                fontWeight: 500,
                fontSize: 32,
                letterSpacing: '-0.01em',
                margin: 0,
                lineHeight: 1.05,
              }}
            >
              Government affairs, <span style={{ fontStyle: 'italic' }}>drafted</span>
            </h1>
            <p
              style={{
                margin: '6px 0 0',
                fontSize: 14,
                color: 'var(--ink-2)',
                lineHeight: 1.5,
                maxWidth: 420,
              }}
            >
              From NDAA requests to member letters — every work product your program depends on,
              built with Meri.
            </p>
          </div>
          <button
            className="btn btn-primary"
            onClick={newDocument}
            disabled={createDraft.isPending}
          >
            <Icon name="Plus" size={14} />
            New document
          </button>
        </header>

        <WsTabs active="library" onNav={(k) => navigate(`/workspace/${k}`)} />

        {/* Start with Meri */}
        <div
          className="card"
          style={{
            padding: 18,
            marginBottom: 22,
            background: 'var(--accent-soft)',
            border: '1px solid #C9D5F2',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              color: 'var(--accent-ink)',
              fontWeight: 700,
              fontSize: 13,
              marginBottom: 4,
              whiteSpace: 'nowrap',
            }}
          >
            <Icon name="Sparkles" size={16} />
            <span>Start with Meri</span>
          </div>
          <div style={{ fontSize: 13, color: 'var(--ink-2)', marginBottom: 12, maxWidth: 620 }}>
            Describe the ask in plain language. Meri picks the work product, drafts the outline, and
            pulls in client, offices and program data from the platform.
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <input
              className="field"
              style={{
                flex: 1,
                background: 'var(--bg-surface)',
                padding: '10px 13px',
                fontSize: 13,
              }}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && draftWithMeri()}
              placeholder="$10M plus-up for Aerovance's JaiaBot HYDRO, Navy RDT&E, targeting HAC-D and SASC…"
            />
            <MeriBtn onClick={draftWithMeri}>Draft it</MeriBtn>
          </div>
        </div>

        {/* Or pick a work product — filtered by sector */}
        <div
          style={{
            display: 'flex',
            alignItems: 'baseline',
            justifyContent: 'space-between',
            marginBottom: 10,
          }}
        >
          <Kicker>Or start from a work product</Kicker>
          <span style={{ fontSize: 12, color: 'var(--ink-3)' }}>filtered by sector</span>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7, marginBottom: 16 }}>
          <SectorChip label="All sectors" on={sector === null} onClick={() => setSector(null)} />
          {(industries ?? []).map((ind) => (
            <SectorChip
              key={ind}
              label={ind}
              on={sector === ind}
              onClick={() => setSector(sector === ind ? null : ind)}
            />
          ))}
        </div>

        {/* Product cards */}
        {isLoading ? (
          <div style={{ textAlign: 'center', padding: 60 }}>
            <Spin />
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14 }}>
            {gridProducts.map((name) => {
              const m = PRODUCT_META[name] ?? { icon: 'FileText', desc: '' };
              return (
                <button
                  key={name}
                  className="card"
                  onClick={() => startProduct(name)}
                  disabled={createDraft.isPending}
                  style={{
                    textAlign: 'left',
                    padding: 16,
                    cursor: 'pointer',
                    font: 'inherit',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 9,
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                    }}
                  >
                    <span
                      style={{
                        width: 34,
                        height: 34,
                        borderRadius: 8,
                        background: 'var(--accent-soft)',
                        color: 'var(--accent)',
                        display: 'grid',
                        placeItems: 'center',
                      }}
                    >
                      <Icon name={m.icon} size={18} />
                    </span>
                  </div>
                  <div style={{ fontWeight: 600, fontSize: 14 }}>{name}</div>
                  <div style={{ fontSize: 12, color: 'var(--ink-3)', lineHeight: 1.4, flex: 1 }}>
                    {m.desc}
                  </div>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'flex-end',
                      paddingTop: 9,
                      borderTop: '1px solid var(--border-1)',
                    }}
                  >
                    <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--accent)' }}>
                      Start →
                    </span>
                  </div>
                </button>
              );
            })}

            {/* "Don't see it?" */}
            <div
              className="card"
              style={{
                padding: 16,
                display: 'flex',
                flexDirection: 'column',
                gap: 9,
                borderStyle: 'dashed',
                background: 'var(--bg-surface-2)',
              }}
            >
              <span
                style={{
                  width: 34,
                  height: 34,
                  borderRadius: 8,
                  background: 'var(--bg-sunken)',
                  color: 'var(--ink-3)',
                  display: 'grid',
                  placeItems: 'center',
                }}
              >
                <Icon name="Plus" size={18} />
              </span>
              <div style={{ fontWeight: 600, fontSize: 14 }}>Don't see it?</div>
              <div style={{ fontSize: 12, color: 'var(--ink-3)', lineHeight: 1.4, flex: 1 }}>
                Build a custom work product with Meri, or request one Capiro doesn't offer yet.
              </div>
              <div
                style={{
                  display: 'flex',
                  gap: 7,
                  paddingTop: 9,
                  borderTop: '1px solid var(--border-1)',
                }}
              >
                <button className="btn sm btn-accent" onClick={draftWithMeri}>
                  <Icon name="Sparkles" size={12} />
                  Build with Meri
                </button>
                <button
                  className="btn sm"
                  style={{ color: 'var(--ink-2)' }}
                  onClick={() => setShowRequest(true)}
                >
                  <Icon name="Mail" size={12} />
                  Request
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {showRequest && (
        <RequestProductModal onClose={() => setShowRequest(false)} onMeri={draftWithMeri} />
      )}

      {meriIntake.isPending && <MeriDraftingOverlay />}
    </div>
  );
}

function SectorChip({ label, on, onClick }: { label: string; on: boolean; onClick: () => void }) {
  return (
    <button
      className="btn sm"
      onClick={onClick}
      style={{
        borderColor: on ? 'var(--accent)' : 'var(--border-1)',
        background: on ? 'var(--accent-soft)' : 'var(--bg-surface)',
        color: on ? 'var(--accent-ink)' : 'var(--ink-2)',
      }}
    >
      {on && <Icon name="Check" size={12} />}
      {label}
    </button>
  );
}

/** Full-bleed loading overlay with a real spinner (Meri intake / drafting). */
export function MeriDraftingOverlay({
  title = 'Meri is drafting…',
  detail = 'Setting up your draft and pulling in your context.',
}: {
  title?: string;
  detail?: string;
}) {
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(12,26,56,.28)',
        display: 'grid',
        placeItems: 'center',
        zIndex: 90,
      }}
    >
      <div
        className="card"
        style={{ width: 360, maxWidth: '92%', padding: 28, textAlign: 'center' }}
      >
        <div style={{ marginBottom: 14 }}>
          <Spin size="large" />
        </div>
        <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 7 }}>{title}</div>
        <div style={{ fontSize: 13, color: 'var(--ink-2)', lineHeight: 1.5 }}>{detail}</div>
      </div>
    </div>
  );
}

/** Request-a-product modal: build with Meri, or submit a ticket to Capiro. */
function RequestProductModal({ onClose, onMeri }: { onClose: () => void; onMeri: () => void }) {
  const [mode, setMode] = useState<null | 'ticket'>(null);
  const [desc, setDesc] = useState('');
  const [submitted, setSubmitted] = useState(false);

  const overlay = {
    position: 'fixed' as const,
    inset: 0,
    background: 'rgba(12,26,56,.28)',
    display: 'grid',
    placeItems: 'center' as const,
    zIndex: 80,
  };

  if (submitted) {
    return (
      <div style={overlay} onClick={onClose}>
        <div
          className="card"
          style={{ width: 420, maxWidth: '92%', padding: 28, textAlign: 'center' }}
          onClick={(e) => e.stopPropagation()}
        >
          <div
            style={{
              width: 44,
              height: 44,
              borderRadius: '50%',
              background: 'var(--success-soft)',
              color: 'var(--success)',
              display: 'grid',
              placeItems: 'center',
              margin: '0 auto 14px',
            }}
          >
            <Icon name="Check" size={22} />
          </div>
          <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 7 }}>Request submitted</div>
          <div style={{ fontSize: 13, color: 'var(--ink-2)', lineHeight: 1.5, marginBottom: 18 }}>
            The Capiro team will review your request and reach out if this product gets added to the
            catalog.
          </div>
          <button
            className="btn btn-accent"
            onClick={onClose}
            style={{ width: '100%', justifyContent: 'center' }}
          >
            Done
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={overlay} onClick={onClose}>
      <div
        className="card"
        style={{ width: 460, maxWidth: '92%', padding: 0, overflow: 'hidden' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          style={{
            padding: '16px 20px',
            borderBottom: '1px solid var(--border-1)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <div style={{ fontSize: 15, fontWeight: 700 }}>Don't see what you need?</div>
          <button
            onClick={onClose}
            style={{
              border: 'none',
              background: 'none',
              cursor: 'pointer',
              color: 'var(--ink-3)',
              display: 'grid',
              placeItems: 'center',
            }}
          >
            <Icon name="X" size={16} />
          </button>
        </div>

        {mode === null && (
          <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 11 }}>
            <button
              onClick={onMeri}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 13,
                padding: '14px 16px',
                border: '1.5px solid var(--accent)',
                background: 'var(--accent-soft)',
                borderRadius: 10,
                cursor: 'pointer',
                textAlign: 'left',
                font: 'inherit',
              }}
            >
              <span
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: 9,
                  background: 'var(--accent)',
                  color: '#fff',
                  display: 'grid',
                  placeItems: 'center',
                  flex: 'none',
                }}
              >
                <Icon name="Sparkles" size={18} />
              </span>
              <div>
                <div style={{ fontSize: 13.5, fontWeight: 700, marginBottom: 4 }}>
                  Build a custom product with Meri
                </div>
                <div style={{ fontSize: 12, color: 'var(--ink-2)', lineHeight: 1.45 }}>
                  Describe the work product in plain language. Meri will scaffold the outline, pull
                  in your context, and open the editor.
                </div>
              </div>
            </button>
            <button
              onClick={() => setMode('ticket')}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 13,
                padding: '14px 16px',
                border: '1px solid var(--border-1)',
                background: 'var(--bg-surface-2)',
                borderRadius: 10,
                cursor: 'pointer',
                textAlign: 'left',
                font: 'inherit',
              }}
            >
              <span
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: 9,
                  background: 'var(--bg-sunken)',
                  color: 'var(--ink-3)',
                  display: 'grid',
                  placeItems: 'center',
                  flex: 'none',
                }}
              >
                <Icon name="Send" size={18} />
              </span>
              <div>
                <div style={{ fontSize: 13.5, fontWeight: 700, marginBottom: 4 }}>
                  Request it from Capiro
                </div>
                <div style={{ fontSize: 12, color: 'var(--ink-2)', lineHeight: 1.45 }}>
                  Submit a short description. Capiro's team reviews and adds it to the catalog if
                  there's broad demand.
                </div>
              </div>
            </button>
          </div>
        )}

        {mode === 'ticket' && (
          <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div>
              <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 7 }}>
                Describe the work product you need
              </div>
              <textarea
                value={desc}
                onChange={(e) => setDesc(e.target.value)}
                rows={4}
                placeholder="e.g. A pre-meeting research brief summarizing a Member's prior votes on a specific policy topic…"
                className="field"
                style={{ resize: 'vertical', fontFamily: 'var(--font-sans)' }}
              />
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn" onClick={() => setMode(null)}>
                Back
              </button>
              <button
                className="btn btn-accent"
                disabled={!desc.trim()}
                style={{ opacity: desc.trim() ? 1 : 0.5 }}
                onClick={() => setSubmitted(true)}
              >
                <Icon name="Send" size={13} />
                Submit request
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
