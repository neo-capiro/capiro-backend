// 2A — Send team invites (final unlocked step). Prototype InvitesOverlay wired
// to POST /api/tenant-admin/team/invite (one call per row) and
// POST /onboard-api/setup/complete once at least one invite lands.
import React from 'react';
import { Btn, Icon, Modal, SelectInput, TextInput } from '../../ui/primitives';
import { errorMessage } from '../funnel/shared';
import { useCapiroApi } from '../../lib/capiro-api';
import { useSetupApi } from '../../lib/setup';

type RoleLabel = 'Standard User' | 'Admin';

interface InviteRow {
  email: string;
  role: RoleLabel;
}

const emptyRow = (): InviteRow => ({ email: '', role: 'Standard User' });

export function InvitesOverlay({
  orgName,
  appBaseUrl,
  onClose,
  onCompleted,
}: {
  orgName: string;
  appBaseUrl: string;
  onClose: () => void;
  /** Setup completed (≥1 invite sent + POST /setup/complete) — parent refetches. */
  onCompleted: () => void;
}) {
  const capiro = useCapiroApi();
  const setupApi = useSetupApi();
  const fileRef = React.useRef<HTMLInputElement>(null);

  const [rows, setRows] = React.useState<InviteRow[]>([emptyRow(), emptyRow(), emptyRow()]);
  const [sending, setSending] = React.useState(false);
  const [sent, setSent] = React.useState(false);
  const [sentCount, setSentCount] = React.useState(0);
  const [failures, setFailures] = React.useState<string[]>([]);

  const valid = rows.filter((r) => r.email.includes('@'));
  const setRow = (i: number, patch: Partial<InviteRow>) => {
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  };

  /** Minimal bulk CSV: one `email[,role]` per line, appended as rows. */
  const handleCsv = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    void file.text().then((text) => {
      const parsed: InviteRow[] = text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [email, role] = line.split(',').map((s) => s.trim());
          return {
            email: email ?? '',
            role: (/admin/i.test(role ?? '') ? 'Admin' : 'Standard User') as RoleLabel,
          };
        })
        .filter((r) => r.email.includes('@'));
      if (parsed.length > 0) {
        setRows((prev) => [...prev.filter((r) => r.email.trim() !== ''), ...parsed]);
      }
    });
  };

  const send = async () => {
    if (sending || valid.length === 0) return;
    setSending(true);
    setFailures([]);
    const failed: string[] = [];
    let ok = 0;
    for (const row of valid) {
      try {
        await capiro.inviteTeamMember({
          email: row.email.trim(),
          role: row.role === 'Admin' ? 'user_admin' : 'standard_user',
        });
        ok += 1;
      } catch (err) {
        failed.push(`${row.email.trim()}: ${errorMessage(err)}`);
      }
    }
    if (ok >= 1) {
      try {
        await setupApi.completeSetup();
      } catch (err) {
        failed.push(errorMessage(err));
      }
      onCompleted();
      setSentCount(ok);
      setSent(true);
    }
    setFailures(failed);
    setSending(false);
  };

  return (
    <Modal title="Invite your team" onClose={onClose} width={560}>
      {!sent ? (
        <div style={{ display: 'grid', gap: 10 }}>
          {rows.map((r, i) => (
            <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 160px', gap: 10 }}>
              <TextInput
                placeholder="name@firm.com"
                value={r.email}
                onChange={(e) => setRow(i, { email: e.target.value })}
              />
              <SelectInput
                options={['Standard User', 'Admin']}
                value={r.role}
                onChange={(v) => setRow(i, { role: v as RoleLabel })}
              />
            </div>
          ))}
          <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
            <a
              href="#"
              onClick={(e) => {
                e.preventDefault();
                setRows((prev) => [...prev, emptyRow()]);
              }}
              style={{ fontSize: 12.5, color: 'var(--accent)', fontWeight: 600 }}
            >
              + Add another
            </a>
            <a
              href="#"
              onClick={(e) => {
                e.preventDefault();
                fileRef.current?.click();
              }}
              style={{
                fontSize: 12.5,
                color: 'var(--accent)',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
              }}
            >
              <Icon name="FileUp" size={12} />
              Bulk CSV import
            </a>
            <input
              ref={fileRef}
              type="file"
              accept=".csv,text/csv"
              style={{ display: 'none' }}
              onChange={handleCsv}
            />
          </div>
          {failures.length > 0 && (
            <div style={{ fontSize: 12, color: 'var(--critical)', lineHeight: 1.5 }}>
              {failures.map((f, i) => (
                <div key={i}>{f}</div>
              ))}
            </div>
          )}
          <div
            style={{
              display: 'flex',
              justifyContent: 'flex-end',
              gap: 10,
              borderTop: '1px solid var(--border-1)',
              paddingTop: 14,
            }}
          >
            <Btn onClick={onClose}>Cancel</Btn>
            <Btn
              variant="primary"
              disabled={valid.length === 0 || sending}
              onClick={() => void send()}
            >
              {sending ? 'Sending…' : `Send ${valid.length} Invite${valid.length === 1 ? '' : 's'}`}
            </Btn>
          </div>
        </div>
      ) : (
        <div style={{ textAlign: 'center', padding: '14px 0 4px' }}>
          <div
            style={{
              width: 46,
              height: 46,
              borderRadius: '50%',
              background: 'var(--success-soft)',
              display: 'grid',
              placeItems: 'center',
              margin: '0 auto 14px',
            }}
          >
            <Icon name="Check" size={22} strokeWidth={2.6} style={{ color: 'var(--success)' }} />
          </div>
          <b style={{ fontSize: 15 }}>Invites sent</b>
          <p style={{ margin: '6px 0 18px', fontSize: 12.5, color: 'var(--ink-2)' }}>
            {sentCount} teammates will get an email to join {orgName}. Each connects their own email
            and calendar on first login.
          </p>
          {failures.length > 0 && (
            <div
              style={{
                fontSize: 12,
                color: 'var(--critical)',
                lineHeight: 1.5,
                margin: '0 0 14px',
              }}
            >
              {failures.map((f, i) => (
                <div key={i}>{f}</div>
              ))}
            </div>
          )}
          <Btn
            variant="primary"
            onClick={() => window.location.assign(appBaseUrl)}
            icon="ArrowRight"
            style={{ width: '100%' }}
          >
            Continue to Capiro
          </Btn>
        </div>
      )}
    </Modal>
  );
}
