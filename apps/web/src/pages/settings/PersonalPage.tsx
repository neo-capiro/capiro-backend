import { useEffect, useRef, useState } from 'react';
import { Alert, App, Button, Card, Descriptions, Form, Input, Switch, Tag } from 'antd';
import { CloudUploadOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMe, type MeResponse } from '../../lib/me.js';
import { useApi } from '../../lib/use-api.js';
import { RichTextEditor } from '../engagement/outreach/v2/RichTextEditor.js';
import { sanitizeSignatureHtml } from '../engagement/outreach/v2/richtext.js';
// The signature editor reuses the outreach RichTextEditor, whose styles
// (.ov2-rte-*) + design tokens live in these (namespaced, side-effect-free)
// stylesheets. email-signature.css adds the card-specific chrome.
import '../engagement/outreach/v2/outreach.css';
import '../engagement/outreach/v2/step-generate.css';
import './email-signature.css';

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
export function PersonalPage() {
  const api = useApi();
  const qc = useQueryClient();
  const { message } = App.useApp();
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
      message.success('Saved');
    },
    onError: (err: unknown) => {
      message.error(err instanceof Error ? err.message : 'Save failed');
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
      message.success('Signature saved');
    },
    onError: (err: unknown) => {
      message.error(saveErrorMessage(err));
    },
  });

  const readSignatureFile = (file: File) => {
    const isImage = /^image\//i.test(file.type) || /\.(png|jpe?g|gif|webp|bmp)$/i.test(file.name);
    if (isImage) {
      readSignatureImageFile(file);
      return;
    }
    if (!/\.html?$/i.test(file.name) && file.type !== 'text/html') {
      message.error('Please choose an image (PNG, JPG, GIF, WEBP) or an .html / .htm file');
      return;
    }
    if (file.size > 2_000_000) {
      message.error('That file is too large (max 2 MB)');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const raw = typeof reader.result === 'string' ? reader.result : '';
      // Sanitize client-side for display; the server re-sanitizes on Save.
      const clean = sanitizeSignatureHtml(raw);
      if (clean.length > MAX_SIGNATURE_HTML_LENGTH) {
        message.error(
          'That signature is too large (max ~2 MB). Try removing or shrinking embedded images.',
        );
        return;
      }
      setSigHtml(clean);
      message.success('Signature imported — review below, then Save');
    };
    reader.onerror = () => message.error('Could not read that file');
    reader.readAsText(file);
  };

  // Upload an image OF a signature (a photo or scan). We downscale it to a sane
  // max width and re-encode as a data-URI <img>, so the stored signature is a
  // single self-contained image that renders in every email client. Downscaling
  // keeps the base64 blob well under the server cap (sanitizeSignatureHtml).
  const readSignatureImageFile = (file: File) => {
    if (file.size > 10_000_000) {
      message.error('That image is too large (max 10 MB before resizing)');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = typeof reader.result === 'string' ? reader.result : '';
      if (!dataUrl.startsWith('data:image/')) {
        message.error('Could not read that image');
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
          message.error('Could not process that image');
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
          message.error('That image type is not supported');
          return;
        }
        if (clean.length > MAX_SIGNATURE_HTML_LENGTH) {
          message.error('That image is too large after resizing (max ~2 MB). Try a smaller image.');
          return;
        }
        setSigHtml(clean);
        message.success('Signature image added — review below, then Save');
      };
      img.onerror = () => message.error('Could not load that image');
      img.src = dataUrl;
    };
    reader.onerror = () => message.error('Could not read that image');
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
    <>
      <Card title="Profile" style={{ marginBottom: 16 }}>
        <Form layout="vertical">
          <Form.Item
            label="Title"
            extra="Displayed under your name in the top-right profile widget. e.g. “Sr. Government Affairs Lead”."
          >
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Add your title"
              maxLength={120}
              showCount
              allowClear
              style={{ maxWidth: 480 }}
            />
          </Form.Item>
          <Form.Item style={{ marginBottom: 0 }}>
            <Button
              type="primary"
              disabled={!dirty || saveTitle.isPending}
              loading={saveTitle.isPending}
              onClick={() => saveTitle.mutate(trimmed)}
            >
              Save
            </Button>
          </Form.Item>
        </Form>
      </Card>
      <Card title="Account" style={{ marginBottom: 16 }}>
        <Descriptions column={1} size="small" bordered>
          <Descriptions.Item label="User ID">{me.data.user.id}</Descriptions.Item>
          <Descriptions.Item label="Tenant">{me.data.tenant.slug}</Descriptions.Item>
          <Descriptions.Item label="Role">{me.data.role}</Descriptions.Item>
        </Descriptions>
      </Card>

      <Card
        title={
          <span>
            Email signature{' '}
            <Tag color="blue" style={{ marginInlineStart: 4 }}>
              New
            </Tag>
          </span>
        }
        style={{ marginBottom: 16 }}
        className="sig-block"
      >
        <p className="sig-intro">
          Your signature is automatically appended to campaign emails. Type it directly, paste from
          Outlook or Gmail, upload an image of your signature, or upload an HTML file. Toggle it on
          or off per campaign at send time.
        </p>

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
          className={`sig-dropzone${dragging ? ' dragging' : ''}`}
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
          <span className="sig-dropzone-icon">
            <CloudUploadOutlined />
          </span>
          <div>
            <div className="sig-dropzone-main">Upload a signature image or HTML file</div>
            <div className="sig-dropzone-sub">
              Drag and drop, or browse — image (PNG, JPG, GIF, WEBP) or .html / .htm
            </div>
          </div>
          <span className="sig-dropzone-spacer" />
          <Button size="small">Browse file</Button>
        </div>
        <div className="sig-export-hint">
          Export your signature from Outlook (File → Options → Mail → Signatures → save as HTML) or
          Gmail (copy source). Then upload it here.
        </div>

        <div className="sig-divider">or compose manually</div>

        <div className="sig-editor">
          <RichTextEditor
            variant="signature"
            value={sigHtml}
            onChange={setSigHtml}
            placeholder="Type your signature, or paste it from Outlook / Gmail…"
          />
        </div>

        <div className="sig-toggle-row">
          <Switch checked={sigEnabled} onChange={setSigEnabled} />
          <div>
            <div className="sig-toggle-label">Append signature to campaign emails by default</div>
            <div className="sig-toggle-sub">You can still toggle it per campaign at send time.</div>
          </div>
        </div>

        {sigTooLong && (
          <div style={{ marginTop: 12, fontSize: 12, color: 'var(--danger, #cf1322)' }}>
            This signature is too large to save (max ~2 MB). Remove or shrink embedded images.
          </div>
        )}

        <div className="sig-actions">
          <Button onClick={resetSignature} disabled={!sigDirty || saveSignature.isPending}>
            Cancel
          </Button>
          <Button
            type="primary"
            onClick={() => saveSignature.mutate()}
            loading={saveSignature.isPending}
            disabled={!sigDirty || sigTooLong}
          >
            Save signature
          </Button>
        </div>
      </Card>

      <Card title="Identity (Clerk)">
        <Alert
          type="info"
          showIcon
          message="Email, password, and MFA settings are managed in Clerk."
          description="Click your account in the bottom-left navigation to open Clerk's account settings."
          style={{ marginBottom: 16 }}
        />
      </Card>
    </>
  );
}
