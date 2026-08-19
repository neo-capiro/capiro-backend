/**
 * vNext re-skin of pages/settings/PersonalPage.tsx — identical endpoints,
 * query keys, copy, the base64 signature transport (WAF workaround), the
 * client-side size caps, the image-downscale pipeline and the Clerk pointer.
 * The signature editor is the vNext SettingsRichTextEditor over the same
 * UI-free sanitizers (richtext.ts).
 */
import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { UploadCloud } from 'lucide-react';
import { useMe, type MeResponse } from '../../../lib/me.js';
import { useApi } from '../../../lib/use-api.js';
import { sanitizeSignatureHtml } from '../../../pages/engagement/outreach/v2/richtext.js';
import { CapiroButton } from '../../components/actions/index.js';
import { CapiroBadge } from '../../components/badges/index.js';
import { CapiroInput } from '../../components/fields/index.js';
import { useCapiroToast } from '../../components/feedback/toast.js';
import { SettingsRichTextEditor } from './SettingsRichTextEditor.js';
import { SvCallout, SvCard, SvDescriptions, SvSwitch } from './settings-ui.js';

interface EmailSignatureResponse {
  html: string | null;
  enabled: boolean;
}

// Mirrors the server cap (MAX_SIGNATURE_HTML_LENGTH in sanitize-signature.ts).
// Guarding client-side avoids an opaque 400 when a large pasted/uploaded
// signature (e.g. an Outlook export with an inline logo, or an uploaded
// signature image) exceeds it.
const MAX_SIGNATURE_HTML_LENGTH = 18_000_000;

// Signature HTML is sent to the API base64-encoded: a raw HTML body trips the
// WAF's XSS body rule (403 before it reaches the API). The server decodes then
// sanitizes (the authoritative XSS boundary). Chunked to keep the call stack
// bounded on large (inline-image) signatures.
function toBase64Utf8(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function saveErrorMessage(err: unknown): string {
  const data = (err as { response?: { data?: { message?: string | string[] } } })?.response?.data;
  if (data?.message) return Array.isArray(data.message) ? data.message.join('; ') : data.message;
  return err instanceof Error ? err.message : 'Could not save signature';
}

/**
 * Personal settings, the only Settings tab everyone sees. Identity surfaces
 * (email, password, MFA) live in Clerk's hosted UserButton modal; Capiro
 * surfaces the link here. Capiro-owned profile fields (job title, email
 * signature) live in this page.
 */
export function VNextPersonalPage() {
  const api = useApi();
  const qc = useQueryClient();
  const toast = useCapiroToast();
  const me = useMe();
  const [title, setTitle] = useState('');

  useEffect(() => {
    setTitle(me.data?.user.title ?? '');
  }, [me.data?.user.title]);

  const saveTitle = useMutation({
    mutationFn: async (next: string) =>
      (await api.patch<MeResponse>('/api/me', { title: next })).data,
    onSuccess: (data) => {
      qc.setQueryData(['me'], data);
      toast.success('Saved');
    },
    onError: (err: unknown) => {
      toast.error(err instanceof Error ? err.message : 'Save failed');
    },
  });

  // ---- Email signature ----
  const fileRef = useRef<HTMLInputElement>(null);
  const [sigHtml, setSigHtml] = useState('');
  const [sigEnabled, setSigEnabled] = useState(false);
  const [dragging, setDragging] = useState(false);

  const signatureQuery = useQuery<EmailSignatureResponse>({
    queryKey: ['me', 'email-signature'],
    queryFn: async () => (await api.get<EmailSignatureResponse>('/api/me/email-signature')).data,
    staleTime: 30_000,
    retry: false,
  });

  // Hydrate the editor + toggle from the loaded signature.
  useEffect(() => {
    if (!signatureQuery.data) return;
    setSigHtml(signatureQuery.data.html ?? '');
    setSigEnabled(signatureQuery.data.enabled);
  }, [signatureQuery.data]);

  const saveSignature = useMutation({
    mutationFn: async () =>
      (
        await api.put<EmailSignatureResponse>('/api/me/email-signature', {
          htmlBase64: toBase64Utf8(sigHtml),
          enabled: sigEnabled,
        })
      ).data,
    onSuccess: (data) => {
      qc.setQueryData(['me', 'email-signature'], data);
      // /me carries emailSignatureEnabled + hasEmailSignature (used by the
      // outreach send step), so refresh it.
      qc.invalidateQueries({ queryKey: ['me'] });
      setSigHtml(data.html ?? '');
      setSigEnabled(data.enabled);
      toast.success('Signature saved');
    },
    onError: (err: unknown) => {
      toast.error(saveErrorMessage(err));
    },
  });

  const readSignatureFile = (file: File) => {
    const isImage = /^image\//i.test(file.type) || /\.(png|jpe?g|gif|webp|bmp)$/i.test(file.name);
    if (isImage) {
      readSignatureImageFile(file);
      return;
    }
    if (!/\.html?$/i.test(file.name) && file.type !== 'text/html') {
      toast.error('Please choose an image (PNG, JPG, GIF, WEBP) or an .html / .htm file');
      return;
    }
    if (file.size > 2_000_000) {
      toast.error('That file is too large (max 2 MB)');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const raw = typeof reader.result === 'string' ? reader.result : '';
      // Sanitize client-side for display; the server re-sanitizes on Save.
      const clean = sanitizeSignatureHtml(raw);
      if (clean.length > MAX_SIGNATURE_HTML_LENGTH) {
        toast.error(
          'That signature is too large (max ~2 MB). Try removing or shrinking embedded images.',
        );
        return;
      }
      setSigHtml(clean);
      toast.success('Signature imported — review below, then Save');
    };
    reader.onerror = () => toast.error('Could not read that file');
    reader.readAsText(file);
  };

  // Upload an image OF a signature (a photo or scan). We downscale it to a sane
  // max width and re-encode as a data-URI <img>, so the stored signature is a
  // single self-contained image that renders in every email client. Downscaling
  // keeps the base64 blob well under the server cap (sanitizeSignatureHtml).
  const readSignatureImageFile = (file: File) => {
    if (file.size > 10_000_000) {
      toast.error('That image is too large (max 10 MB before resizing)');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = typeof reader.result === 'string' ? reader.result : '';
      if (!dataUrl.startsWith('data:image/')) {
        toast.error('Could not read that image');
        return;
      }
      const img = new Image();
      img.onload = () => {
        // Cap the rendered width so the signature isn't a giant block; preserve
        // aspect ratio. 600px is roughly an email content column.
        const MAX_W = 600;
        const scale = img.width > MAX_W ? MAX_W / img.width : 1;
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          toast.error('Could not process that image');
          return;
        }
        ctx.drawImage(img, 0, 0, w, h);
        // PNG keeps transparency (common for signature cut-outs); fall back to
        // the original data URL if canvas export somehow fails.
        let out = dataUrl;
        try {
          out = canvas.toDataURL('image/png');
        } catch {
          out = dataUrl;
        }
        const imgHtml = `<p><img src="${out}" alt="Signature" width="${w}" height="${h}" style="max-width:100%;" /></p>`;
        const clean = sanitizeSignatureHtml(imgHtml);
        if (!clean || !/<img\b/i.test(clean)) {
          toast.error('That image type is not supported');
          return;
        }
        if (clean.length > MAX_SIGNATURE_HTML_LENGTH) {
          toast.error('That image is too large after resizing (max ~2 MB). Try a smaller image.');
          return;
        }
        setSigHtml(clean);
        toast.success('Signature image added — review below, then Save');
      };
      img.onerror = () => toast.error('Could not load that image');
      img.src = dataUrl;
    };
    reader.onerror = () => toast.error('Could not read that image');
    reader.readAsDataURL(file);
  };

  if (!me.data) return null;

  const trimmed = title.trim();
  const dirty = trimmed !== (me.data.user.title ?? '');

  const loadedSig = signatureQuery.data;
  const sigDirty =
    !!loadedSig && (sigHtml !== (loadedSig.html ?? '') || sigEnabled !== loadedSig.enabled);
  const sigTooLong = sigHtml.length > MAX_SIGNATURE_HTML_LENGTH;

  const resetSignature = () => {
    setSigHtml(loadedSig?.html ?? '');
    setSigEnabled(loadedSig?.enabled ?? false);
  };

  return (
    <div className="stv-stack">
      <SvCard title="Profile">
        <div className="stv-stack">
          <span style={{ maxWidth: 480 }}>
            <CapiroInput
              label="Title"
              placeholder="Add your title"
              maxLength={120}
              helpText="Displayed under your name in the top-right profile widget. e.g. “Sr. Government Affairs Lead”."
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </span>
          <div className="stv-row">
            <CapiroButton
              variant="primary"
              disabled={!dirty || saveTitle.isPending}
              loading={saveTitle.isPending}
              onClick={() => saveTitle.mutate(trimmed)}
            >
              Save
            </CapiroButton>
          </div>
        </div>
      </SvCard>

      <SvCard title="Account">
        <SvDescriptions
          items={[
            { label: 'User ID', value: me.data.user.id },
            { label: 'Tenant', value: me.data.tenant.slug },
            { label: 'Role', value: me.data.role },
          ]}
        />
      </SvCard>

      <SvCard
        title={
          <span className="stv-row" style={{ gap: 8 }}>
            Email signature <CapiroBadge tone="info">New</CapiroBadge>
          </span>
        }
        description="Your signature is automatically appended to campaign emails. Type it directly, paste from Outlook or Gmail, upload an image of your signature, or upload an HTML file. Toggle it on or off per campaign at send time."
      >
        <div className="stv-stack">
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp,image/bmp,.png,.jpg,.jpeg,.gif,.webp,.bmp,.html,.htm,text/html"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) readSignatureFile(f);
              e.target.value = '';
            }}
          />
          <div
            className={`stv-dropzone${dragging ? ' dragging' : ''}`}
            onClick={() => fileRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              const f = e.dataTransfer.files?.[0];
              if (f) readSignatureFile(f);
            }}
          >
            <UploadCloud size={22} aria-hidden="true" />
            <div>
              <div className="stv-dropzone-main">Upload a signature image or HTML file</div>
              <div className="stv-dropzone-sub">
                Drag and drop, or browse — image (PNG, JPG, GIF, WEBP) or .html / .htm
              </div>
            </div>
            <span className="stv-spacer" />
            <CapiroButton size="compact">Browse file</CapiroButton>
          </div>
          <div className="stv-muted stv-small">
            Export your signature from Outlook (File → Options → Mail → Signatures → save as HTML)
            or Gmail (copy source). Then upload it here.
          </div>

          <div className="stv-divider-label">or compose manually</div>

          <SettingsRichTextEditor
            variant="signature"
            value={sigHtml}
            onChange={setSigHtml}
            placeholder="Type your signature, or paste it from Outlook / Gmail…"
          />

          <div className="stv-row stv-row--start">
            <SvSwitch
              checked={sigEnabled}
              onChange={setSigEnabled}
              aria-label="Append signature to campaign emails by default"
            />
            <div>
              <div className="stv-strong">Append signature to campaign emails by default</div>
              <div className="stv-muted stv-small">
                You can still toggle it per campaign at send time.
              </div>
            </div>
          </div>

          {sigTooLong && (
            <div className="stv-danger-text stv-small">
              This signature is too large to save (max ~2 MB). Remove or shrink embedded images.
            </div>
          )}

          <div className="stv-row stv-row--end">
            <CapiroButton onClick={resetSignature} disabled={!sigDirty || saveSignature.isPending}>
              Cancel
            </CapiroButton>
            <CapiroButton
              variant="primary"
              onClick={() => saveSignature.mutate()}
              loading={saveSignature.isPending}
              disabled={!sigDirty || sigTooLong}
            >
              Save signature
            </CapiroButton>
          </div>
        </div>
      </SvCard>

      <SvCard title="Identity (Clerk)">
        <SvCallout
          kind="info"
          title="Email, password, and MFA settings are managed in Clerk."
          description="Click your account in the bottom-left navigation to open Clerk's account settings."
        />
      </SvCard>
    </div>
  );
}
