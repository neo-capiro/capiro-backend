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
  GRANTS_GOV_APPLICANT_TYPES,
} from '@capiro/shared';
import type { Client, ClientFormSubmit, ClientFormValues } from './clientTypes.js';
import { SET_ASIDE_CERTIFICATION_OPTIONS } from './client-registrations.js';
import { useApi } from '../../lib/use-api.js';
import {
  CLIENT_FORM_STEP_FIELDS,
  CLIENT_FORM_STEP_TITLES,
  SAM_STATUS_OPTIONS,
  clientToFormValues,
  formValuesToClientPayload,
  formatPhone,
} from './client-form-mapping.js';

// The step structure and the form ⇄ payload mapping moved to the UI-free
// `client-form-mapping.ts`, shared with the vNext wizard. Re-exported here so
// this module's public surface is unchanged.
export { clientToFormValues, formValuesToClientPayload } from './client-form-mapping.js';

interface ClientFormModalProps {
  open: boolean;
  mode: 'create' | 'edit';
  client?: Client | null;
  submitting: boolean;
  onCancel: () => void;
  onSubmit: (submission: ClientFormSubmit) => void;
}

// antd `Steps` items derived from the shared step titles.
const STEP_ITEMS = CLIENT_FORM_STEP_TITLES.map((title) => ({ title }));
const STEP_FIELDS = CLIENT_FORM_STEP_FIELDS;

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
            // Shared with the read-side Registrations card (client-registrations.ts)
            // so the picked label and the rendered label are one list.
            options={[...SET_ASIDE_CERTIFICATION_OPTIONS]}
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

function uploadFileToFile(file?: UploadFile): File | undefined {
  return (file?.originFileObj as File | undefined) ?? (file as unknown as File | undefined);
}
