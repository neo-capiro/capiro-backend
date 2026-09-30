import {
  GRANTS_GOV_ORGANIZATION_TYPE_GROUPS,
  GRANTS_GOV_OTHER_APPLICANTS,
  GRANTS_GOV_UNRESTRICTED_APPLICANTS,
  applicantTypeKey,
  getClientOrganizationTypes,
  getGrantsGovOrganizationTypeLabel,
} from '@capiro/shared';

/** Shared by both profile editors; submitted values retain their Grants.gov identity. */
export function OrganizationTypesField({
  id,
  value = [],
  onChange,
}: {
  id?: string;
  value?: string[];
  onChange?: (value: string[]) => void;
}) {
  const selected = getClientOrganizationTypes(value);
  const selectedKeys = new Set(selected.map(applicantTypeKey));
  const outdated = value.filter((item) => !selectedKeys.has(applicantTypeKey(item)));
  const summary = selected.length
    ? selected.length <= 2
      ? selected.map(getGrantsGovOrganizationTypeLabel).join(' · ')
      : `${selected.length} organization types selected`
    : 'Select organization types';
  const update = (type: string, checked: boolean) =>
    onChange?.(checked ? [...selected, type] : selected.filter((item) => item !== type));

  return (
    <fieldset className="capiro-org-types" id={id}>
      <legend>Organization types</legend>
      <p className="capiro-org-types__help">
        Select only the legal organization types that apply to this client. These help check grant
        eligibility; capabilities and funding priorities describe which opportunities fit.
      </p>
      {outdated.length > 0 ? (
        <div className="capiro-org-types__review" role="status">
          <strong>Saved selections need review</strong>
          <p>
            {outdated
              .map((item) =>
                applicantTypeKey(item) === applicantTypeKey(GRANTS_GOV_UNRESTRICTED_APPLICANTS)
                  ? 'Unrestricted'
                  : applicantTypeKey(item) === applicantTypeKey(GRANTS_GOV_OTHER_APPLICANTS)
                    ? 'Other'
                    : item,
              )
              .join(' · ')}
          </p>
          <p>
            These are not recognized organization types. Other and Unrestricted describe an
            opportunity’s eligibility rules. They stay saved until you update organization types or
            remove them here.
          </p>
          <button type="button" onClick={() => onChange?.(selected)}>
            Remove outdated selections
          </button>
        </div>
      ) : null}
      <details className="capiro-org-types__picker">
        <summary>{summary}</summary>
        <div className="capiro-org-types__groups">
          {GRANTS_GOV_ORGANIZATION_TYPE_GROUPS.map((group) => (
            <fieldset className="capiro-org-types__group" key={group.id}>
              <legend>{group.label}</legend>
              {group.options.map((option) => (
                <label key={option.value} title={option.value}>
                  <input
                    type="checkbox"
                    checked={selected.includes(option.value)}
                    onChange={(event) => update(option.value, event.target.checked)}
                  />
                  <span>{option.label}</span>
                </label>
              ))}
            </fieldset>
          ))}
        </div>
        {selected.length > 0 ? (
          <button type="button" onClick={() => onChange?.([])}>
            Clear organization types
          </button>
        ) : null}
      </details>
    </fieldset>
  );
}
