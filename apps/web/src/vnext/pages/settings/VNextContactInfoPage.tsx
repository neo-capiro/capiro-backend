/**
 * vNext re-skin of pages/settings/ContactInfoPage.tsx — identical endpoints,
 * query keys, copy and states; presentation on the vNext primitives.
 */
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../../../lib/use-api.js';
import { CapiroButton } from '../../components/actions/index.js';
import { CapiroInput } from '../../components/fields/index.js';
import { CapiroSkeleton } from '../../components/feedback/index.js';
import { useCapiroToast } from '../../components/feedback/toast.js';
import { SvCard } from './settings-ui.js';

interface ContactInfo {
  name?: string;
  phone?: string;
  email?: string;
  mailingStreet1?: string;
  mailingStreet2?: string;
  mailingCity?: string;
  mailingStateZip?: string;
  permanentStreet1?: string;
  permanentStreet2?: string;
  permanentCity?: string;
  permanentStateZip?: string;
}

export function VNextContactInfoPage() {
  const api = useApi();
  const toast = useCapiroToast();
  const qc = useQueryClient();
  const [values, setValues] = useState<ContactInfo>({});

  const { data, isPending } = useQuery<ContactInfo>({
    queryKey: ['contact-info'],
    queryFn: async () => (await api.get<ContactInfo>('/api/tenant-admin/contact-info')).data,
    staleTime: 30_000,
  });

  useEffect(() => {
    if (data) setValues(data);
  }, [data]);

  const save = useMutation({
    mutationFn: async (next: ContactInfo) =>
      (await api.put<ContactInfo>('/api/tenant-admin/contact-info', next)).data,
    onSuccess: () => {
      toast.success('Contact info saved');
      qc.invalidateQueries({ queryKey: ['contact-info'] });
    },
    onError: () => toast.error('Save failed'),
  });

  const set = (key: keyof ContactInfo) => (value: string) =>
    setValues((current) => ({ ...current, [key]: value }));

  if (isPending) {
    return (
      <SvCard aria-label="Loading contact info">
        <div className="stv-stack">
          <CapiroSkeleton height={20} width="40%" />
          <CapiroSkeleton height={36} />
          <CapiroSkeleton height={36} />
          <CapiroSkeleton height={36} />
        </div>
      </SvCard>
    );
  }

  return (
    <form
      className="stv-stack"
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate(values);
      }}
    >
      <SvCard title="Organization Contact">
        <div className="stv-grid-2">
          <CapiroInput label="Organization name" value={values.name ?? ''} onChange={(e) => set('name')(e.target.value)} />
          <CapiroInput label="Email" value={values.email ?? ''} onChange={(e) => set('email')(e.target.value)} />
          <CapiroInput label="Phone" value={values.phone ?? ''} onChange={(e) => set('phone')(e.target.value)} />
        </div>
      </SvCard>

      <SvCard title="Mailing Address">
        <div className="stv-stack">
          <CapiroInput label="Street 1" value={values.mailingStreet1 ?? ''} onChange={(e) => set('mailingStreet1')(e.target.value)} />
          <CapiroInput label="Street 2" value={values.mailingStreet2 ?? ''} onChange={(e) => set('mailingStreet2')(e.target.value)} />
          <div className="stv-grid-2">
            <CapiroInput label="City" value={values.mailingCity ?? ''} onChange={(e) => set('mailingCity')(e.target.value)} />
            <CapiroInput label="State / ZIP" placeholder="VA 22201" value={values.mailingStateZip ?? ''} onChange={(e) => set('mailingStateZip')(e.target.value)} />
          </div>
        </div>
      </SvCard>

      <SvCard title="Permanent Address">
        <div className="stv-stack">
          <CapiroInput label="Street 1" value={values.permanentStreet1 ?? ''} onChange={(e) => set('permanentStreet1')(e.target.value)} />
          <CapiroInput label="Street 2" value={values.permanentStreet2 ?? ''} onChange={(e) => set('permanentStreet2')(e.target.value)} />
          <div className="stv-grid-2">
            <CapiroInput label="City" value={values.permanentCity ?? ''} onChange={(e) => set('permanentCity')(e.target.value)} />
            <CapiroInput label="State / ZIP" placeholder="VA 22201" value={values.permanentStateZip ?? ''} onChange={(e) => set('permanentStateZip')(e.target.value)} />
          </div>
        </div>
      </SvCard>

      <div className="stv-row">
        <CapiroButton variant="primary" type="submit" loading={save.isPending}>
          Save contact info
        </CapiroButton>
      </div>
    </form>
  );
}
