import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useClientFacilities } from '../../../pages/clients/use-client-facilities.js';
import { useApi } from '../../../lib/use-api.js';
import {
  createClientFacility,
  chooseClientFacilityGeocodeCandidate,
  deleteClientFacility,
  resolveClientFacilityDistrict,
  updateClientFacility,
  DISTRICT_PATTERN,
  US_HOUSE_SEATS,
  US_STATE_CODES,
  formatFacilityDistrict,
  type ClientFacility,
  type FacilityPayload,
} from '../../../pages/clients/facilities-api.js';
import { CapiroButton } from '../../components/actions/index.js';
import { CapiroModal } from '../../components/overlays/index.js';
import { CapiroInput, CapiroSelect } from '../../components/fields/index.js';
import { useCapiroToast } from '../../components/feedback/toast.js';
import './manage-facilities-modal.css';
import { FacilityVerification } from './FacilityVerification.js';

/**
 * "Manage facilities" — vNext client-facility manager.
 *
 * The District Nexus header button used to
 * `navigate('/clients?clientId=…&tab=facilities')`. On os.capiro.ai that does
 * nothing: `client-crm-routing`'s LEGACY_TABS maps `tab=facilities` back to
 * `intelligence/district`, the exact view the button sits on. So it was dead.
 *
 * This is the real editor on the real CRUD (`/api/clients/:id/facilities`),
 * sharing the `['client-facilities', clientId]` cache entry that District Nexus,
 * the Overview intel pulse, and the canonical profile all read — so an edit here
 * refreshes the district footprint immediately.
 *
 * Validation mirrors the server so the common mistakes are caught before a 400:
 * the district is the BARE number ("12", or "00" at-large) with the state carried
 * separately, and a district is only valid within its state's seat count. The
 * server ALSO geocodes on write; `geocodeStatus` is surfaced read-only rather
 * than guessed at, and a manual district entry is left alone when the geocoder
 * has not resolved one.
 */

interface Draft {
  name: string;
  addressLine: string;
  city: string;
  state: string;
  zip: string;
  congressionalDistrict: string;
  employeeCount: string;
  notes: string;
}

const EMPTY_DRAFT: Draft = {
  name: '',
  addressLine: '',
  city: '',
  state: '',
  zip: '',
  congressionalDistrict: '',
  employeeCount: '',
  notes: '',
};

function draftOf(facility: ClientFacility): Draft {
  return {
    name: facility.name,
    addressLine: facility.addressLine ?? '',
    city: facility.city ?? '',
    state: facility.state ?? '',
    zip: facility.zip ?? '',
    congressionalDistrict: facility.congressionalDistrict ?? '',
    employeeCount: facility.employeeCount != null ? String(facility.employeeCount) : '',
    notes: facility.notes ?? '',
  };
}

export function ManageFacilitiesModal({
  open,
  clientId,
  clientName,
  onClose,
}: {
  open: boolean;
  clientId: string;
  clientName: string;
  onClose: () => void;
}) {
  return (
    <CapiroModal open={open} title={`Facilities — ${clientName}`} onClose={onClose}>
      <ManageFacilitiesBody clientId={clientId} onClose={onClose} />
    </CapiroModal>
  );
}

function ManageFacilitiesBody({ clientId, onClose }: { clientId: string; onClose: () => void }) {
  const api = useApi();
  const qc = useQueryClient();
  const toast = useCapiroToast();
  /** null = closed; 'new' = create; otherwise the facility id being edited. */
  const [editing, setEditing] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<ClientFacility | null>(null);

  const facilitiesQ = useClientFacilities(clientId);
  const facilities = facilitiesQ.data ?? [];

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['client-facilities', clientId] });
    void qc.invalidateQueries({ queryKey: ['client-representation', clientId] });
    // The scored district models are derived from facilities, so they go stale
    // on every write here.
    void qc.invalidateQueries({ queryKey: ['client-district-nexus', clientId] });
    void qc.invalidateQueries({ queryKey: ['pf-district-nexus-v2', clientId] });
  };

  const save = useMutation({
    mutationFn: ({ id, payload }: { id: string | null; payload: FacilityPayload }) =>
      id
        ? updateClientFacility(api, clientId, id, payload)
        : createClientFacility(api, clientId, payload),
    onSuccess: (_facility, { id }) => {
      toast.success(id ? 'Facility updated' : 'Facility added');
      setEditing(null);
      invalidate();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const resolve = useMutation({
    mutationFn: (id: string) => resolveClientFacilityDistrict(api, clientId, id),
    onSuccess: (facility) => {
      qc.setQueryData<ClientFacility[]>(['client-facilities', clientId], (current) =>
        current?.map((item) => (item.id === facility.id ? facility : item)),
      );
      if (facility.geocodeStatus === 'matched') toast.success('Location resolved');
      else if (facility.geocodeStatus === 'pending') toast.success('Location resolution requested');
      else
        toast.error(
          facility.geocodeStatus === 'error'
            ? 'Location service unavailable. Try resolving again.'
            : 'Address needs review. Check the address or choose a suggested match.',
        );
      invalidate();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const chooseCandidate = useMutation({
    mutationFn: ({ id, candidateIndex }: { id: string; candidateIndex: number }) =>
      chooseClientFacilityGeocodeCandidate(api, clientId, id, candidateIndex),
    onSuccess: (facility) => {
      qc.setQueryData<ClientFacility[]>(['client-facilities', clientId], (current) =>
        current?.map((item) => (item.id === facility.id ? facility : item)),
      );
      toast.success('Census address accepted');
      invalidate();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const remove = useMutation({
    mutationFn: (id: string) => deleteClientFacility(api, clientId, id),
    onSuccess: () => {
      toast.success('Facility removed');
      setConfirmDelete(null);
      invalidate();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  return (
    <div className="capiro-facmod">
      <p className="capiro-facmod__hint">
        Facilities are what give this client a congressional footprint — each one’s state and
        district drive District Nexus, representative matching, and every district-based
        recommendation.
      </p>

      {facilitiesQ.isLoading ? (
        <p className="capiro-facmod__empty">Loading facilities…</p>
      ) : facilitiesQ.isError ? (
        <div className="capiro-facmod__error">
          <span>Could not load facilities.</span>
          <CapiroButton
            variant="secondary"
            size="compact"
            onClick={() => void facilitiesQ.refetch()}
          >
            Retry
          </CapiroButton>
        </div>
      ) : (
        <ul className="capiro-facmod__list">
          {facilities.length === 0 ? (
            <li className="capiro-facmod__empty">
              No facilities recorded yet. Add one to give this client a district footprint.
            </li>
          ) : (
            facilities.map((facility) =>
              editing === facility.id ? (
                <li key={facility.id} className="capiro-facmod__row is-editing">
                  <FacilityForm
                    initial={draftOf(facility)}
                    resolution={facility}
                    saving={save.isPending}
                    onCancel={() => setEditing(null)}
                    onSubmit={(payload) => save.mutate({ id: facility.id, payload })}
                  />
                </li>
              ) : (
                <li key={facility.id} className="capiro-facmod__row">
                  <span className="capiro-facmod__who">
                    <span className="capiro-facmod__name">{facility.name}</span>
                    <span className="capiro-facmod__meta">{facilityMeta(facility)}</span>
                    <FacilityResolutionSummary
                      facility={facility}
                      resolving={resolve.isPending && resolve.variables === facility.id}
                      onResolve={() => resolve.mutate(facility.id)}
                      choosing={
                        chooseCandidate.isPending && chooseCandidate.variables?.id === facility.id
                      }
                      onChoose={(candidateIndex) =>
                        chooseCandidate.mutate({ id: facility.id, candidateIndex })
                      }
                    />
                  </span>
                  <CapiroButton
                    variant="secondary"
                    size="compact"
                    onClick={() => setEditing(facility.id)}
                  >
                    Edit
                  </CapiroButton>
                  <button
                    type="button"
                    className="capiro-facmod__remove"
                    onClick={() => setConfirmDelete(facility)}
                  >
                    Remove
                  </button>
                </li>
              ),
            )
          )}
        </ul>
      )}

      {editing === 'new' ? (
        <div className="capiro-facmod__new">
          <FacilityForm
            initial={EMPTY_DRAFT}
            saving={save.isPending}
            onCancel={() => setEditing(null)}
            onSubmit={(payload) => save.mutate({ id: null, payload })}
          />
        </div>
      ) : null}

      <div className="capiro-facmod__footer">
        {editing !== 'new' ? (
          <CapiroButton variant="primary" size="compact" onClick={() => setEditing('new')}>
            Add facility
          </CapiroButton>
        ) : null}
        <span className="capiro-facmod__spacer" />
        <CapiroButton variant="secondary" size="compact" onClick={onClose}>
          Done
        </CapiroButton>
      </div>

      {/* Destructive, and a removed facility silently changes the district
          footprint — so it confirms rather than firing on the first click. */}
      <CapiroModal
        open={Boolean(confirmDelete)}
        title="Remove facility"
        onClose={() => setConfirmDelete(null)}
      >
        <p className="capiro-facmod__confirm">
          Remove <strong>{confirmDelete?.name}</strong>? Its district contribution disappears from
          this client’s footprint.
        </p>
        <div className="capiro-facmod__footer">
          <span className="capiro-facmod__spacer" />
          <CapiroButton variant="secondary" size="compact" onClick={() => setConfirmDelete(null)}>
            Cancel
          </CapiroButton>
          <CapiroButton
            variant="primary"
            size="compact"
            loading={remove.isPending}
            onClick={() => confirmDelete && remove.mutate(confirmDelete.id)}
          >
            Remove
          </CapiroButton>
        </div>
      </CapiroModal>
    </div>
  );
}

function canResolveFacility(facility: ClientFacility): boolean {
  // A manual district is not a coordinate. Keep recovery available for those
  // locations too, including an interrupted background attempt.
  return Boolean(facility.addressLine?.trim() && facility.city?.trim() && facility.state?.trim());
}

function FacilityResolutionSummary({
  facility,
  resolving,
  onResolve,
  choosing = false,
  onChoose,
}: {
  facility: ClientFacility;
  resolving: boolean;
  onResolve?: () => void;
  choosing?: boolean;
  onChoose?: (candidateIndex: number) => void;
}) {
  return (
    <span className="capiro-facmod__resolution">
      <FacilityVerification facility={facility} />
      {facility.geocodeStatus === 'ambiguous' && facility.geocodeCandidates?.length ? (
        <span className="capiro-facmod__recommendation">
          <span>Choose a Census address:</span>
          {facility.geocodeCandidates.map((candidate, index) => (
            <span key={`${candidate.matchedAddress ?? 'candidate'}-${index}`}>
              <span>
                {candidate.matchedAddress ?? 'Address unavailable'}
                {candidate.congressionalDistrict
                  ? ` · District ${candidate.congressionalDistrict}`
                  : ''}
              </span>
              {onChoose && candidate.matchedAddress ? (
                <CapiroButton
                  variant="quiet"
                  size="compact"
                  loading={choosing}
                  onClick={() => onChoose(index)}
                >
                  Use this address
                </CapiroButton>
              ) : null}
            </span>
          ))}
        </span>
      ) : null}
      {canResolveFacility(facility) && onResolve ? (
        <CapiroButton variant="quiet" size="compact" loading={resolving} onClick={onResolve}>
          Resolve district
        </CapiroButton>
      ) : null}
    </span>
  );
}

/** "Seattle, WA · WA-07 · 240 employees" — every part omitted when absent. */
function facilityMeta(facility: ClientFacility): string {
  const district = formatFacilityDistrict(facility.state, facility.congressionalDistrict);
  const place = [facility.city, facility.state].filter(Boolean).join(', ');
  const parts = [
    place || null,
    district || null,
    facility.employeeCount != null
      ? `${facility.employeeCount.toLocaleString('en-US')} employees`
      : null,
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'No location recorded';
}

function FacilityForm({
  initial,
  resolution,
  saving,
  onCancel,
  onSubmit,
}: {
  initial: Draft;
  resolution?: ClientFacility;
  saving: boolean;
  onCancel: () => void;
  onSubmit: (payload: FacilityPayload) => void;
}) {
  const [draft, setDraft] = useState<Draft>(initial);
  const [errors, setErrors] = useState<Partial<Record<keyof Draft, string>>>({});

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => (prev[key] ? { ...prev, [key]: undefined } : prev));
  };

  const seats = useMemo(() => US_HOUSE_SEATS[draft.state.toUpperCase()], [draft.state]);

  const validate = (): Partial<Record<keyof Draft, string>> => {
    const next: Partial<Record<keyof Draft, string>> = {};
    if (!draft.name.trim()) next.name = 'Give the facility a name';

    const district = resolution?.districtSource === 'geocoded' &&
      draft.congressionalDistrict.trim() === initial.congressionalDistrict.trim()
      ? '' : draft.congressionalDistrict.trim();
    if (district) {
      if (!DISTRICT_PATTERN.test(district)) {
        next.congressionalDistrict = 'Use the bare number, e.g. 12 (or 00 for at-large)';
      } else if (!draft.state) {
        // The server cross-checks district against state, so a district with no
        // state cannot be validated — and would be useless for matching anyway.
        next.congressionalDistrict = 'Pick a state before setting a district';
      } else if (seats != null) {
        const n = Number(district);
        // "00" is the at-large sentinel and is only meaningful where there is
        // exactly one seat; otherwise the district must be within the delegation.
        const ok = seats === 1 ? n === 0 || n === 1 : n >= 1 && n <= seats;
        if (!ok) {
          next.congressionalDistrict =
            seats === 1
              ? `${draft.state.toUpperCase()} has a single at-large district — use 00`
              : `${draft.state.toUpperCase()} has ${seats} districts`;
        }
      }
    }

    const employees = draft.employeeCount.trim();
    if (employees && !/^\d+$/.test(employees)) {
      next.employeeCount = 'Whole number of employees, or leave blank';
    }
    return next;
  };

  const submit = () => {
    const found = validate();
    setErrors(found);
    if (Object.values(found).some(Boolean)) return;

    const employees = draft.employeeCount.trim();
    onSubmit({
      name: draft.name.trim(),
      // Explicit `null` rather than omission: this same payload is used for
      // PATCH, where omitting a field means "leave it alone" — so clearing a
      // value has to be said out loud.
      addressLine: draft.addressLine.trim() || null,
      city: draft.city.trim() || null,
      state: draft.state || null,
      zip: draft.zip.trim() || null,
      ...(!resolution || draft.congressionalDistrict.trim() !== initial.congressionalDistrict.trim()
        ? { congressionalDistrict: draft.congressionalDistrict.trim() || null }
        : {}),
      employeeCount: employees ? Number(employees) : null,
      notes: draft.notes.trim() || null,
    });
  };

  return (
    <form
      className="capiro-facmod__form"
      // Custom inline messages instead of native browser bubbles.
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      {resolution ? (
        <div className="capiro-facmod__edit-resolution">
          <span className="capiro-facmod__label">Current district resolution</span>
          <FacilityResolutionSummary facility={resolution} resolving={false} />
        </div>
      ) : null}
      <div className="capiro-facmod__grid">
        <div className="capiro-facmod__span2">
          <CapiroInput
            label="Facility name"
            placeholder="e.g. Seattle HQ"
            autoFocus
            required
            value={draft.name}
            error={errors.name}
            onChange={(event) => set('name', event.target.value)}
          />
        </div>
        <div className="capiro-facmod__span2">
          <CapiroInput
            label="Street address"
            placeholder="1201 3rd Ave"
            value={draft.addressLine}
            onChange={(event) => set('addressLine', event.target.value)}
          />
        </div>
        <CapiroInput
          label="City"
          value={draft.city}
          onChange={(event) => set('city', event.target.value)}
        />
        <CapiroSelect
          label="State"
          value={draft.state}
          options={[
            { value: '', label: 'Not set' },
            ...US_STATE_CODES.map((code) => ({ value: code, label: code })),
          ]}
          onChange={(event) => set('state', event.target.value)}
        />
        <CapiroInput
          label="ZIP"
          value={draft.zip}
          onChange={(event) => set('zip', event.target.value)}
        />
        <CapiroInput
          label="District"
          placeholder="12"
          inputMode="numeric"
          helpText="Bare number. Left blank, the geocoder resolves it from the address."
          value={draft.congressionalDistrict}
          error={errors.congressionalDistrict}
          onChange={(event) => set('congressionalDistrict', event.target.value)}
        />
        <CapiroInput
          label="Employees"
          placeholder="240"
          inputMode="numeric"
          value={draft.employeeCount}
          error={errors.employeeCount}
          onChange={(event) => set('employeeCount', event.target.value)}
        />
      </div>

      <div className="capiro-facmod__field">
        <label className="capiro-facmod__label" htmlFor="capiro-facmod-notes">
          Notes
        </label>
        <textarea
          id="capiro-facmod-notes"
          className="capiro-input capiro-facmod__textarea"
          rows={2}
          value={draft.notes}
          onChange={(event) => set('notes', event.target.value)}
        />
      </div>

      <div className="capiro-facmod__form-actions">
        <CapiroButton variant="secondary" size="compact" type="button" onClick={onCancel}>
          Cancel
        </CapiroButton>
        <CapiroButton variant="primary" size="compact" type="submit" loading={saving}>
          Save facility
        </CapiroButton>
      </div>
    </form>
  );
}

function errorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'response' in error) {
    const data = (error as { response?: { data?: { message?: unknown } } }).response?.data;
    if (typeof data?.message === 'string') return data.message;
    if (Array.isArray(data?.message)) return data.message.join(', ');
  }
  return error instanceof Error ? error.message : 'Could not save the facility';
}
