import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { UploadOutlined } from '@ant-design/icons';
import {
  Button,
  Checkbox,
  Col,
  Divider,
  Form,
  Input,
  Modal,
  Row,
  Select,
  Steps,
  Typography,
  Upload,
  type UploadFile,
} from 'antd';
import {
  SECTOR_LABELS,
  SECTOR_TAGS,
  SUBMISSION_TRACKS,
  SUBMISSION_TRACK_LABELS,
  normalizeSector,
  GRANTS_GOV_APPLICANT_TYPES,
} from '@capiro/shared';
import type { Client, ClientFormSubmit, ClientFormValues, ClientPayload } from './clientTypes.js';
import { useApi } from '../../lib/use-api.js';

interface ClientFormModalProps {
  open: boolean;
  mode: 'create' | 'edit';
  client?: Client | null;
  submitting: boolean;
  onCancel: () => void;
  onSubmit: (submission: ClientFormSubmit) => void;
}

// The 4 wizard steps. Each step gates a subset of the company-info fields; the
// final step submits. Logo + documents live below the steps and are NOT part
// of the company-info field set — they're a separate wired upload feature.
const STEP_ITEMS = [
  { title: 'Company Info' },
  { title: 'Contact & Social' },
  { title: "Gov't Registration" },
  { title: 'Sector & Tracks' },
];

// Field names owned by each step, used to scope per-step validation so Next
// only validates the fields the user has actually seen.
const STEP_FIELDS: Array<Array<keyof ClientFormValues>> = [
  [
    'name',
    'dba',
    'website',
    'description',
    'city',
    'state',
    'country',
    'address1',
    'zip',
    'sbSb',
    'sbWosb',
    'sbSdvosb',
    'sbHubzone',
    'sbEightA',
    'sbLarge',
    'sbForeignOwned',
  ],
  ['primaryContactEmail', 'primaryContactPhone'],
  [
    'cageCode',
    'uei',
    'samStatus',
    'samExpirationDate',
    'primaryNaics',
    'additionalNaics',
    'ldaRegistrantName',
    'ein',
    'naicsCodes',
    'pscCodes',
    'applicantTypes',
    'setAsideCertifications',
  ],
  [
    'sectors',
    'submissionTracks',
    'issueCodes',
    'engagementStartDate',
    'primaryContactName',
    'internalNotes',
  ],
];

const SAM_STATUS_OPTIONS = [
  { label: 'Active', value: 'Active' },
  { label: 'Expired', value: 'Expired' },
  { label: 'Not registered', value: 'Not registered' },
  { label: 'Pending', value: 'Pending' },
];

export function ClientFormModal({
  open,
  mode,
  client,
  submitting,
  onCancel,
  onSubmit,
}: ClientFormModalProps) {
  const [form] = Form.useForm<ClientFormValues>();
  const [documentFiles, setDocumentFiles] = useState<UploadFile[]>([]);
  const [logoFiles, setLogoFiles] = useState<UploadFile[]>([]);
  const [currentStep, setCurrentStep] = useState(0);

  useEffect(() => {
    if (!open) return;
    form.resetFields();
    form.setFieldsValue(clientToFormValues(client ?? undefined));
    setDocumentFiles([]);
    setLogoFiles([]);
    setCurrentStep(0);
  }, [client, form, open]);

  const isLastStep = currentStep === STEP_ITEMS.length - 1;

  async function handleNext() {
    try {
      await form.validateFields(STEP_FIELDS[currentStep] as string[]);
      setCurrentStep((s) => Math.min(s + 1, STEP_ITEMS.length - 1));
    } catch {
      // validateFields rejects with the list of invalid fields; AntD already
      // renders the inline messages, so nothing to do here.
    }
  }

  function handleBack() {
    setCurrentStep((s) => Math.max(s - 1, 0));
  }

  function handleSubmit(values: ClientFormValues) {
    onSubmit({
      // Pass the existing client (edit mode) so intakeData merges over the
      // current blob instead of overwriting it — preserves wired keys the
      // wizard doesn't render (peNumber, profileNotes, governmentHistory…).
      payload: formValuesToClientPayload(values, client ?? undefined),
      documents: documentFiles.map(uploadFileToFile).filter((file): file is File => Boolean(file)),
      logo: uploadFileToFile(logoFiles[0]),
    });
  }

  // The final form.submit() validates ALL steps, but a failed field on a hidden
  // (display:none) step would otherwise give zero feedback. Jump to the step
  // that owns the first errored field, then focus/scroll it once visible.
  function handleFinishFailed({
    errorFields,
  }: {
    errorFields: Array<{ name: Array<string | number> }>;
  }) {
    const firstName = errorFields[0]?.name;
    const fieldKey = firstName?.[0];
    if (firstName === undefined || fieldKey === undefined) return;
    const ownerStep = STEP_FIELDS.findIndex((fields) =>
      (fields as ReadonlyArray<string | number>).includes(fieldKey),
    );
    if (ownerStep >= 0) setCurrentStep(ownerStep);
    // Defer until after the owning step re-renders out of display:none.
    setTimeout(() => {
      form.scrollToField(firstName, { block: 'center' });
      const instance = form.getFieldInstance(firstName) as { focus?: () => void } | undefined;
      instance?.focus?.();
    }, 0);
  }

  return (
    <Modal
      title={mode === 'create' ? 'Add client' : 'Edit client'}
      open={open}
      onCancel={onCancel}
      width={760}
      footer={[
        <Button key="cancel" onClick={onCancel}>
          Cancel
        </Button>,
        currentStep > 0 ? (
          <Button key="back" onClick={handleBack}>
            Back
          </Button>
        ) : null,
        !isLastStep ? (
          <Button key="next" type="primary" onClick={handleNext}>
            Next
          </Button>
        ) : (
          <Button key="submit" type="primary" loading={submitting} onClick={() => form.submit()}>
            {mode === 'create' ? 'Add client' : 'Save changes'}
          </Button>
        ),
      ]}
    >
      <Steps size="small" current={currentStep} items={STEP_ITEMS} style={{ marginBottom: 24 }} />

      {/*
        One Form spans all steps; we mount every step but hide the inactive ones
        with `display: none` rather than unmounting, so field values + validation
        state survive Back/Next without re-initialising the controls.
      */}
      <Form
        form={form}
        layout="vertical"
        onFinish={handleSubmit}
        onFinishFailed={handleFinishFailed}
      >
        <div style={{ display: currentStep === 0 ? 'block' : 'none' }}>
          <CompanyInfoStep />
        </div>
        <div style={{ display: currentStep === 1 ? 'block' : 'none' }}>
          <ContactSocialStep form={form} />
        </div>
        <div style={{ display: currentStep === 2 ? 'block' : 'none' }}>
          <GovRegistrationStep form={form} />
        </div>
        <div style={{ display: currentStep === 3 ? 'block' : 'none' }}>
          <SectorTracksStep />
        </div>

        {/* Logo + documents — separate wired upload feature, shown on every
            step so they can be attached regardless of where the user is. */}
        <Divider orientation="left" plain>
          Logo &amp; documents
        </Divider>
        <Row gutter={16}>
          <Col xs={24}>
            <Form.Item label="Client logo">
              <Upload
                accept="image/png,image/jpeg,image/svg+xml,image/webp"
                fileList={logoFiles}
                maxCount={1}
                beforeUpload={(file) => {
                  setLogoFiles([file]);
                  return false;
                }}
                onRemove={() => {
                  setLogoFiles([]);
                }}
              >
                <Button icon={<UploadOutlined />}>Select logo</Button>
              </Upload>
            </Form.Item>
          </Col>
          <Col xs={24}>
            <Form.Item label="Documents">
              <Upload
                multiple
                fileList={documentFiles}
                beforeUpload={(file) => {
                  setDocumentFiles((current) => [...current, file]);
                  return false;
                }}
                onRemove={(file) => {
                  setDocumentFiles((current) => current.filter((item) => item.uid !== file.uid));
                }}
              >
                <Button icon={<UploadOutlined />}>Select documents</Button>
              </Upload>
            </Form.Item>
          </Col>
        </Row>
      </Form>
    </Modal>
  );
}

/* ── Step 1: Company Info ────────────────────────────────────────────────── */

function CompanyInfoStep() {
  return (
    <>
      <Typography.Text type="secondary" style={{ display: 'block', marginBottom: 12 }}>
        Company Information
      </Typography.Text>
      <Row gutter={16}>
        <Col xs={24} md={12}>
          <Form.Item name="name" label="Legal name" rules={[{ required: true, min: 1 }]}>
            <Input placeholder="Acme Defense Systems, Inc." />
          </Form.Item>
        </Col>
        <Col xs={24} md={12}>
          <Form.Item name="dba" label="DBA / trade name">
            <Input placeholder="Acme Defense" />
          </Form.Item>
        </Col>
        <Col xs={24} md={12}>
          <Form.Item name="website" label="Website" rules={[{ required: true }]}>
            <Input placeholder="example.com" />
          </Form.Item>
        </Col>
        <Col xs={24}>
          <Form.Item
            name="description"
            label="Company description"
            rules={[{ required: true, min: 1 }]}
          >
            <Input.TextArea rows={3} maxLength={600} showCount />
          </Form.Item>
        </Col>
        <Col xs={24} md={10}>
          <Form.Item name="city" label="City">
            <Input />
          </Form.Item>
        </Col>
        <Col xs={24} md={7}>
          <Form.Item name="state" label="State">
            <Input placeholder="VA" maxLength={2} />
          </Form.Item>
        </Col>
        <Col xs={24} md={7}>
          <Form.Item name="country" label="Country" initialValue="USA">
            <Input placeholder="USA" />
          </Form.Item>
        </Col>
        <Col xs={24} md={17}>
          <Form.Item name="address1" label="Street address">
            <Input placeholder="123 Main St" />
          </Form.Item>
        </Col>
        <Col xs={24} md={7}>
          <Form.Item name="zip" label="ZIP">
            <Input placeholder="22201" maxLength={10} />
          </Form.Item>
        </Col>
      </Row>

      <Divider orientation="left" plain>
        Small Business Classification
      </Divider>
      <Row gutter={[16, 4]}>
        <Col xs={12} md={8}>
          <Form.Item name="sbSb" valuePropName="checked" noStyle>
            <Checkbox>Small Business (SB)</Checkbox>
          </Form.Item>
        </Col>
        <Col xs={12} md={8}>
          <Form.Item name="sbWosb" valuePropName="checked" noStyle>
            <Checkbox>WOSB</Checkbox>
          </Form.Item>
        </Col>
        <Col xs={12} md={8}>
          <Form.Item name="sbSdvosb" valuePropName="checked" noStyle>
            <Checkbox>SDVOSB</Checkbox>
          </Form.Item>
        </Col>
        <Col xs={12} md={8}>
          <Form.Item name="sbHubzone" valuePropName="checked" noStyle>
            <Checkbox>HUBZone</Checkbox>
          </Form.Item>
        </Col>
        <Col xs={12} md={8}>
          <Form.Item name="sbEightA" valuePropName="checked" noStyle>
            <Checkbox>8(a)</Checkbox>
          </Form.Item>
        </Col>
        <Col xs={12} md={8}>
          <Form.Item name="sbLarge" valuePropName="checked" noStyle>
            <Checkbox>Large Business</Checkbox>
          </Form.Item>
        </Col>
        <Col xs={12} md={8}>
          <Form.Item name="sbForeignOwned" valuePropName="checked" noStyle>
            <Checkbox>Foreign-owned</Checkbox>
          </Form.Item>
        </Col>
      </Row>
    </>
  );
}

/* ── Step 2: Contact & Social ────────────────────────────────────────────── */

function ContactSocialStep({
  form,
}: {
  form: ReturnType<typeof Form.useForm<ClientFormValues>>[0];
}) {
  return (
    <Row gutter={16}>
      <Col xs={24} md={12}>
        <Form.Item
          name="primaryContactEmail"
          label="Main company email"
          rules={[{ type: 'email' }]}
        >
          <Input placeholder="info@example.com" />
        </Form.Item>
      </Col>
      <Col xs={24} md={12}>
        <Form.Item name="primaryContactPhone" label="Main company phone">
          <Input
            placeholder="+1 202-555-0142"
            onBlur={(event) =>
              form.setFieldValue('primaryContactPhone', formatPhone(event.target.value))
            }
          />
        </Form.Item>
      </Col>
    </Row>
  );
}

/* ── Step 3: Gov't Registration ──────────────────────────────────────────── */

function GovRegistrationStep({
  form,
}: {
  form: ReturnType<typeof Form.useForm<ClientFormValues>>[0];
}) {
  return (
    <Row gutter={16}>
      <Col xs={24} md={12}>
        <Form.Item name="cageCode" label="CAGE Code">
          <Input
            placeholder="1ABC2"
            maxLength={5}
            onChange={(event) => form.setFieldValue('cageCode', event.target.value.toUpperCase())}
          />
        </Form.Item>
      </Col>
      <Col xs={24} md={12}>
        <Form.Item name="uei" label="UEI">
          <Input
            placeholder="ABC123DEF456"
            maxLength={12}
            onChange={(event) => form.setFieldValue('uei', event.target.value.toUpperCase())}
          />
        </Form.Item>
      </Col>
      <Col xs={24} md={12}>
        <Form.Item name="samStatus" label="SAM.gov status">
          <Select allowClear placeholder="Select status" options={SAM_STATUS_OPTIONS} />
        </Form.Item>
      </Col>
      <Col xs={24} md={12}>
        <Form.Item name="samExpirationDate" label="SAM.gov expiration date">
          <Input type="date" />
        </Form.Item>
      </Col>
      <Col xs={24} md={12}>
        <Form.Item name="primaryNaics" label="Primary NAICS">
          <Input placeholder="541330" maxLength={6} />
        </Form.Item>
      </Col>
      <Col xs={24} md={12}>
        <Form.Item name="additionalNaics" label="Additional NAICS">
          <Input placeholder="541512, 541715" />
        </Form.Item>
      </Col>
      <Col xs={24} md={12}>
        <Form.Item name="ldaRegistrantName" label="LDA registrant name">
          <Input placeholder="Registrant on LDA filings" />
        </Form.Item>
      </Col>
      <Col xs={24} md={12}>
        <Form.Item name="ein" label="EIN">
          <Input placeholder="12-3456789" />
        </Form.Item>
      </Col>
      {/* Step 2.3 — first-class NAICS / PSC code lists. These drive client ⇄ PE
          relevance matching (procurement codes), distinct from the legacy free-text
          NAICS fields above which remain for back-compat. */}
      <Col xs={24} md={12}>
        <Form.Item
          name="naicsCodes"
          label="NAICS codes"
          tooltip="Procurement NAICS codes for this client. Type a code and press Enter; used for client ⇄ Program-Element relevance matching."
        >
          <Select
            mode="tags"
            allowClear
            placeholder="541330, 541512"
            tokenSeparators={[',', ' ']}
            options={[]}
          />
        </Form.Item>
      </Col>
      <Col xs={24} md={12}>
        <Form.Item
          name="pscCodes"
          label="PSC codes"
          tooltip="Product/Service codes for this client. Type a code and press Enter; used for client ⇄ Program-Element relevance matching."
        >
          <Select
            mode="tags"
            allowClear
            placeholder="R425, AC12"
            tokenSeparators={[',', ' ']}
            options={[]}
          />
        </Form.Item>
      </Col>
      {/* Grant eligibility. `mode="multiple"` over a fixed list, deliberately NOT
          `mode="tags"` like the two above: District Nexus compares these strings
          directly against federal_grant.eligibility, so a free-typed value
          ("Small Business", "23") would save happily and then match nothing —
          leaving a client that looks configured and still never evaluates as
          eligible, which is worse than leaving it empty. */}
      <Col xs={24}>
        <Form.Item
          name="applicantTypes"
          label="Grant applicant types"
          tooltip="What this client qualifies as on Grants.gov. Drives the District Nexus grant-eligibility column — until it is set, every opportunity reads “needs review” rather than eligible."
        >
          <Select
            mode="multiple"
            allowClear
            optionFilterProp="label"
            placeholder="Select the types this client qualifies as"
            options={GRANTS_GOV_APPLICANT_TYPES.map((t) => ({ value: t, label: t }))}
          />
        </Form.Item>
      </Col>
      <Col xs={24}>
        <Form.Item
          name="setAsideCertifications"
          label="Federal set-aside certifications"
          tooltip="Verified certifications used to evaluate SAM.gov set-aside eligibility. Select only certifications the client currently holds."
        >
          <Select
            mode="multiple"
            allowClear
            optionFilterProp="label"
            placeholder="Select verified certifications"
            options={[
              { value: 'SBA', label: 'Total small business set-aside eligible' },
              { value: 'SBP', label: 'Partial small business set-aside eligible' },
              { value: '8A', label: '8(a)' },
              { value: '8AN', label: '8(a) sole source' },
              { value: 'SDVOSBC', label: 'Service-disabled veteran-owned small business' },
              { value: 'SDVOSBS', label: 'SDVOSB sole source' },
              { value: 'WOSB', label: 'Women-owned small business' },
              { value: 'WOSBSS', label: 'WOSB sole source' },
              { value: 'EDWOSB', label: 'Economically disadvantaged WOSB' },
              { value: 'EDWOSBSS', label: 'EDWOSB sole source' },
              { value: 'HZC', label: 'HUBZone' },
              { value: 'HZS', label: 'HUBZone sole source' },
            ]}
          />
        </Form.Item>
      </Col>
    </Row>
  );
}

/* ── Step 4: Sector & Tracks ─────────────────────────────────────────────── */

function SectorTracksStep() {
  const api = useApi();
  // LDA issue-code reference list (code + English name), for the client-level
  // matching override below.
  const issuesQuery = useQuery<Array<{ code: string; name: string }>>({
    queryKey: ['lda-issues-options', 'client-form'],
    queryFn: async () =>
      (await api.get<Array<{ code: string; name: string }>>('/api/lda-intel/issues')).data,
    staleTime: 30 * 60 * 1000,
  });
  return (
    <>
      <Form.Item
        name="sectors"
        label="Sector tags"
        tooltip="Multi-select. The first sector chosen becomes the primary sector that drives sector-adaptive intelligence panels and comment-period alerts."
      >
        <Checkbox.Group options={SECTOR_TAGS.map((t) => ({ label: SECTOR_LABELS[t], value: t }))} />
      </Form.Item>

      <Form.Item
        name="submissionTracks"
        label="Active submission tracks"
        tooltip="Which legislative / advocacy vehicles this client uses. Drives the insight generator."
      >
        <Checkbox.Group
          options={SUBMISSION_TRACKS.map((t) => ({
            label: SUBMISSION_TRACK_LABELS[t],
            value: t,
          }))}
        />
      </Form.Item>

      <Form.Item
        name="issueCodes"
        label="LDA issue codes (bill/policy matching)"
        tooltip="Federal lobbying issue areas used to auto-match this client to bills and regulations. These normally fill in automatically from the client's LDA match — set them here to add or correct codes when that match is thin or missing."
      >
        <Select
          mode="multiple"
          allowClear
          showSearch
          optionFilterProp="label"
          placeholder={
            issuesQuery.isLoading ? 'Loading issue codes…' : 'Add or correct LDA issue codes'
          }
          loading={issuesQuery.isLoading}
          options={(issuesQuery.data ?? []).map((issue) => ({
            value: issue.code,
            label: `${issue.code} — ${issue.name}`,
          }))}
        />
      </Form.Item>

      <Row gutter={16}>
        <Col xs={24} md={12}>
          <Form.Item name="engagementStartDate" label="Engagement start date">
            <Input type="date" />
          </Form.Item>
        </Col>
        <Col xs={24} md={12}>
          <Form.Item name="primaryContactName" label="Primary POC at client">
            <Input placeholder="Jane Smith" />
          </Form.Item>
        </Col>
      </Row>

      <Form.Item name="internalNotes" label="Internal notes">
        <Input.TextArea rows={3} maxLength={2000} showCount />
      </Form.Item>
    </>
  );
}

/* ── Form ⇄ payload mapping ──────────────────────────────────────────────── */

export function formValuesToClientPayload(
  values: ClientFormValues,
  existing?: Client,
): ClientPayload {
  // Small Business Classification: store only the flags that are checked.
  const sbClassification = compactBooleans({
    sb: values.sbSb,
    wosb: values.sbWosb,
    sdvosb: values.sbSdvosb,
    hubzone: values.sbHubzone,
    eightA: values.sbEightA,
    large: values.sbLarge,
    foreignOwned: values.sbForeignOwned,
  });

  // Sectors multi-select stores the full list; the FIRST selected sector is
  // mirrored to the top-level controlled Client.sectorTag so the wired
  // intelligence engine keeps working.
  const sectors = Array.isArray(values.sectors) ? values.sectors.filter(Boolean) : [];
  const primarySector = sectors[0];

  // The wizard-owned intakeData keys. Compute their new values; an undefined
  // value means "clear this key". Everything NOT in this set (peNumber,
  // profileNotes, governmentHistory, documents, …) is preserved from the
  // existing blob below so editing through the wizard never wipes wired data.
  const wizardIntake: Record<string, unknown> = {
    dba: optionalText(values.dba),
    address1: optionalText(values.address1),
    address2: optionalText(values.address2),
    city: optionalText(values.city),
    state: optionalText(values.state),
    country: optionalText(values.country),
    zip: optionalText(values.zip),
    sbClassification: Object.keys(sbClassification).length ? sbClassification : undefined,
    cageCode: optionalText(values.cageCode)?.toUpperCase(),
    uei: optionalText(values.uei)?.toUpperCase(),
    samStatus: optionalText(values.samStatus),
    samExpirationDate: optionalText(values.samExpirationDate),
    primaryNaics: optionalText(values.primaryNaics),
    additionalNaics: optionalText(values.additionalNaics),
    ldaRegistrantName: optionalText(values.ldaRegistrantName),
    ein: optionalText(values.ein),
    sectors: sectors.length ? sectors : undefined,
    engagementStartDate: optionalText(values.engagementStartDate),
    internalNotes: optionalText(values.internalNotes),
  };

  // Merge: existing blob first, then apply each wizard-owned key (set or
  // delete). Non-wizard keys ride through untouched.
  const intakeData: Record<string, unknown> = { ...toRecord(existing?.intakeData) };
  for (const [key, value] of Object.entries(wizardIntake)) {
    if (value === undefined) delete intakeData[key];
    else intakeData[key] = value;
  }

  const payload: ClientPayload = {
    name: optionalText(values.name) ?? '',
    ...compactObject({
      website: optionalText(values.website),
      description: optionalText(values.description),
      primaryContactName: optionalText(values.primaryContactName),
      primaryContactEmail: optionalText(values.primaryContactEmail),
      primaryContactPhone: formatPhone(values.primaryContactPhone),
    }),
  };
  payload.intakeData = intakeData;
  // Mirror primary sector → controlled top-level tag. Map the chosen label/value
  // to a controlled SECTOR_TAG; SECTOR_TAGS values pass through normalizeSector
  // (which uppercases + matches), so a free label like "Other" still resolves.
  if (primarySector) {
    payload.sectorTag = normalizeSector(primarySector) ?? primarySector;
  }
  if (values.submissionTracks?.length) payload.submissionTracks = values.submissionTracks;
  // Always send issueCodes (even when empty) so clearing the override persists.
  payload.issueCodes = Array.isArray(values.issueCodes) ? values.issueCodes : [];
  if (values.profileType) payload.profileType = values.profileType;
  if (values.profileStatus) payload.profileStatus = values.profileStatus;

  // Step 2.3 — mirror the government identifiers to the first-class client columns the
  // relevance engine reads (clients.uei / cage_code / naics_codes[] / psc_codes[]). UEI/CAGE
  // also continue to ride in intakeData above for back-compat reads; here we additionally send
  // the canonical columns. Always send the arrays (even empty) so clearing them persists.
  payload.uei = optionalText(values.uei)?.toUpperCase() ?? null;
  payload.cageCode = optionalText(values.cageCode)?.toUpperCase() ?? null;
  payload.naicsCodes = normalizeCodes(values.naicsCodes);
  payload.pscCodes = normalizeCodes(values.pscCodes);
  // NOT normalizeCodes: these are exact vendor label strings, and upper-casing or
  // stripping punctuation would stop them matching federal_grant.eligibility.
  payload.applicantTypes = Array.isArray(values.applicantTypes)
    ? values.applicantTypes.filter((v: unknown): v is string => typeof v === 'string')
    : [];
  payload.setAsideCertifications = Array.isArray(values.setAsideCertifications)
    ? values.setAsideCertifications.filter((v: unknown): v is string => typeof v === 'string')
    : [];
  return payload;
}

export function clientToFormValues(client?: Client): ClientFormValues {
  if (!client) return {};
  const intake = toRecord(client.intakeData);
  const sb = toRecord(readFirst(intake, ['sbClassification']));

  // Sectors: prefer the stored multi-select list; otherwise seed from the
  // controlled top-level sectorTag (or legacy free-text sector) so edit mode
  // pre-fills at least the primary sector for clients created before v3.
  const storedSectors = readList(intake, ['sectors']);
  const seedSector =
    (client.sectorTag ?? undefined) || (normalizeSector(readText(intake, ['sector'])) ?? undefined);
  const sectors = storedSectors.length ? storedSectors : seedSector ? [seedSector] : [];

  return {
    name: client.name,
    dba: readText(intake, ['dba']),
    website: client.website ?? undefined,
    description: client.description ?? undefined,
    productDescription: client.productDescription ?? undefined,
    primaryContactName: client.primaryContactName ?? undefined,
    primaryContactEmail: client.primaryContactEmail ?? undefined,
    primaryContactPhone: client.primaryContactPhone ?? undefined,
    sectors,
    submissionTracks: client.submissionTracks ?? [],
    issueCodes: client.issueCodes ?? [],
    profileType: client.profileType ?? undefined,
    profileStatus: client.profileStatus ?? undefined,
    // Address
    address1: readText(intake, ['address1']),
    address2: readText(intake, ['address2']),
    city: readText(intake, ['city']),
    state: readText(intake, ['state']),
    country: readText(intake, ['country']) ?? 'USA',
    zip: readText(intake, ['zip']),
    // Small Business Classification flags
    sbSb: readBool(sb, ['sb']),
    sbWosb: readBool(sb, ['wosb']),
    sbSdvosb: readBool(sb, ['sdvosb']),
    sbHubzone: readBool(sb, ['hubzone']),
    sbEightA: readBool(sb, ['eightA', 'eight_a', '8a']),
    sbLarge: readBool(sb, ['large']),
    sbForeignOwned: readBool(sb, ['foreignOwned', 'foreign_owned']),
    // Gov't registration — prefer the first-class columns (Step 2.3), fall back to intakeData.
    cageCode: client.cageCode ?? readText(intake, ['cageCode', 'cage_code']),
    uei: client.uei ?? readText(intake, ['uei']),
    naicsCodes: Array.isArray(client.naicsCodes) ? client.naicsCodes : [],
    pscCodes: Array.isArray(client.pscCodes) ? client.pscCodes : [],
    applicantTypes: Array.isArray(client.applicantTypes) ? client.applicantTypes : [],
    setAsideCertifications: Array.isArray(client.setAsideCertifications)
      ? client.setAsideCertifications
      : [],
    samStatus: readText(intake, ['samStatus', 'sam_status']),
    samExpirationDate: readDate(intake, ['samExpirationDate', 'sam_expiration_date']),
    primaryNaics: readText(intake, ['primaryNaics', 'primary_naics', 'naics']),
    additionalNaics: readText(intake, ['additionalNaics', 'additional_naics']),
    ldaRegistrantName: readText(intake, ['ldaRegistrantName', 'lda_registrant_name']),
    ein: readText(intake, ['ein']),
    // Sector & tracks
    engagementStartDate: readDate(intake, ['engagementStartDate', 'engagement_start_date']),
    internalNotes: readText(intake, ['internalNotes', 'internal_notes']),
    // ── Legacy reads retained so older intakeData round-trips even though the
    //    wizard no longer renders these fields. ──
    trl: readText(intake, ['trl']),
    fundingAsk: readText(intake, ['fundingAsk', 'funding_ask', 'funding ask']),
    requestType: readText(intake, ['requestType', 'request_type', 'request type']),
    peNumber: readText(intake, ['peNumber', 'pe_number', 'PE number']),
    engagement: readText(intake, ['engagement']),
    portfolioText: readList(intake, ['portfolio', 'tags']).join(', '),
    pocName: readText(intake, ['pocName', 'poc_name']),
    pocTitle: readText(intake, ['pocTitle', 'poc_title']),
    pocPhone: readText(intake, ['pocPhone', 'poc_phone']),
    pocEmail: readText(intake, ['pocEmail', 'poc_email']),
    headName: readText(intake, ['headName', 'head_name']),
    headTitle: readText(intake, ['headTitle', 'head_title']),
  };
}

function optionalText(value: unknown): string | undefined {
  const text = typeof value === 'string' ? value.trim() : String(value ?? '').trim();
  return text.length ? text : undefined;
}

/** Trim + uppercase + de-dupe a code list (NAICS/PSC) from a tags input; drops empties. */
function normalizeCodes(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of value) {
    const code = typeof raw === 'string' ? raw.trim().toUpperCase() : '';
    if (!code || seen.has(code)) continue;
    seen.add(code);
    out.push(code);
  }
  return out;
}

function uploadFileToFile(file?: UploadFile): File | undefined {
  return (file?.originFileObj as File | undefined) ?? (file as unknown as File | undefined);
}

function formatPhone(value: unknown): string | undefined {
  const text = optionalText(value);
  if (!text) return undefined;
  const digits = text.replace(/\D/g, '');
  const normalized = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  if (normalized.length !== 10) return text;
  return `+1 ${normalized.slice(0, 3)}-${normalized.slice(3, 6)}-${normalized.slice(6)}`;
}

function readBool(record: Record<string, unknown>, keys: string[]): boolean {
  const raw = readFirst(record, keys);
  return raw === true || raw === 'true' || raw === 1 || raw === '1';
}

/** Keep only the boolean flags that are truthy. */
function compactBooleans(value: Record<string, boolean | undefined>): Record<string, boolean> {
  return Object.fromEntries(Object.entries(value).filter(([, on]) => on === true)) as Record<
    string,
    boolean
  >;
}

function readList(record: Record<string, unknown>, keys: string[]): string[] {
  const raw = readFirst(record, keys);
  if (Array.isArray(raw)) {
    return raw.map((item) => optionalText(item)).filter((item): item is string => Boolean(item));
  }
  const text = optionalText(raw);
  return text
    ? text
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
}

function readText(record: Record<string, unknown>, keys: string[]): string | undefined {
  return optionalText(readFirst(record, keys));
}

/**
 * Read a date value as a YYYY-MM-DD string suitable for <input type="date">.
 * Truncates any full-ISO timestamp (legacy values) to the date portion.
 */
function readDate(record: Record<string, unknown>, keys: string[]): string | undefined {
  const text = readText(record, keys);
  if (!text) return undefined;
  const match = /^\d{4}-\d{2}-\d{2}/.exec(text);
  return match ? match[0] : text;
}

function readFirst(record: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (key in record) return record[key];
  }
  return undefined;
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function compactObject(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => {
      if (entry == null) return false;
      if (typeof entry === 'string') return entry.trim().length > 0;
      if (Array.isArray(entry)) return entry.length > 0;
      if (typeof entry === 'object') return Object.keys(entry).length > 0;
      return true;
    }),
  );
}
