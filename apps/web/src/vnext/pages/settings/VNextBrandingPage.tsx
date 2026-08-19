/**
 * vNext re-skin of pages/admin/BrandingPage.tsx — identical endpoints, query
 * keys, copy, upload flow (presigned POST + confirm) and the 2 MB client-side
 * guard; presentation on the vNext primitives.
 */
import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../../../lib/use-api.js';
import { CapiroButton } from '../../components/actions/index.js';
import { CapiroInput } from '../../components/fields/index.js';
import { useCapiroToast } from '../../components/feedback/toast.js';
import { SvCard } from './settings-ui.js';

interface BrandingResponse {
  id: string;
  slug: string;
  name: string;
  logoS3Key: string | null;
  logoContentType: string | null;
  logoUploadedAt: string | null;
  logoUrl?: string | null;
}

interface PresignedUrlResponse {
  url: string;
  fields: Record<string, string>;
  s3Key: string;
}

export function VNextBrandingPage() {
  const api = useApi();
  const qc = useQueryClient();
  const toast = useCapiroToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState('');
  const [nameError, setNameError] = useState<string | undefined>();

  const branding = useQuery<BrandingResponse>({
    queryKey: ['branding'],
    queryFn: async () => (await api.get('/api/tenant-admin/branding')).data,
  });

  useEffect(() => {
    if (branding.data) setName(branding.data.name);
  }, [branding.data]);

  const updateName = useMutation({
    mutationFn: async (input: { name: string }) =>
      (await api.put('/api/tenant-admin/branding', input)).data,
    onSuccess: () => {
      toast.success('Saved');
      qc.invalidateQueries({ queryKey: ['branding'] });
    },
  });

  const uploadLogo = useMutation({
    mutationFn: async (file: File) => {
      const presigned = (
        await api.post<PresignedUrlResponse>('/api/tenant-admin/branding/logo/upload-url', {
          contentType: file.type,
          contentLength: file.size,
        })
      ).data;
      // POST the file via the presigned form fields. The API uses
      // createPresignedPost so we get a signed multipart upload that
      // includes content-type validation.
      const fd = new FormData();
      for (const [k, v] of Object.entries(presigned.fields)) fd.append(k, v);
      fd.append('file', file);
      const res = await fetch(presigned.url, { method: 'POST', body: fd });
      if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
      // Confirm, server reads the object metadata and updates the row.
      return (
        await api.post('/api/tenant-admin/branding/logo/confirm', {
          s3Key: presigned.s3Key,
          contentType: file.type,
        })
      ).data;
    },
    onSuccess: () => {
      toast.success('Logo uploaded');
      qc.invalidateQueries({ queryKey: ['branding'] });
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const submitName = () => {
    const trimmed = name.trim();
    if (trimmed.length < 2) {
      setNameError('Company name must be at least 2 characters');
      return;
    }
    setNameError(undefined);
    updateName.mutate({ name: trimmed });
  };

  return (
    <div className="stv-stack">
      <SvCard title="Company name">
        <form
          className="stv-row stv-row--start"
          onSubmit={(event) => {
            event.preventDefault();
            submitName();
          }}
        >
          <span style={{ width: 320, maxWidth: '100%' }}>
            <CapiroInput
              label="Company name"
              placeholder="Company name"
              value={name}
              error={nameError}
              onChange={(e) => setName(e.target.value)}
            />
          </span>
          <CapiroButton variant="primary" type="submit" loading={updateName.isPending} style={{ marginTop: 24 }}>
            Save
          </CapiroButton>
        </form>
      </SvCard>

      <SvCard title="Logo">
        <div className="stv-row stv-row--start">
          {branding.data?.logoUrl ? (
            <img src={branding.data.logoUrl} alt="Tenant logo" className="stv-logo-preview" />
          ) : (
            <div className="stv-logo-empty">No logo</div>
          )}
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/svg+xml"
            style={{ display: 'none' }}
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (!file) return;
              if (file.size > 2 * 1024 * 1024) {
                toast.error('Max 2 MB');
                return;
              }
              uploadLogo.mutate(file);
            }}
          />
          <CapiroButton loading={uploadLogo.isPending} onClick={() => fileRef.current?.click()}>
            Upload logo
          </CapiroButton>
        </div>
      </SvCard>
    </div>
  );
}
