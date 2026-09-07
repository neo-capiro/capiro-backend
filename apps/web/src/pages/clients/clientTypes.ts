export interface SubmissionHistoryEntry {
  fy: string;
  title: string;
  meta: string;
  outcome: string;
  outcomeType: 'success' | 'partial' | 'failed' | 'in_progress';
  notes?: string;
}

export interface Capability {
  id: string;
  name: string;
  type: 'product' | 'service' | 'platform' | 'technology';
  description?: string;
  sector?: string;
  tags?: string[];
  trl?: number;
  mrl?: number;
  peNumber?: string;
  // Step 2.3 — explicit multi-PE list + match keywords used by client ⇄ PE relevance.
  // Optional here (additive) to stay in sync with the canonical CapabilityDrawer interface.
  peNumbers?: string[];
  keywords?: string[];
  appropriationAccount?: string;
  service?: string;
  targetSubcommittee?: string;
  fundingAsk?: number;
  fundingAskLabel?: string;
  justification?: string;
  districtNexus?: string;
  existingContracts?: string;
  submissionHistory?: SubmissionHistoryEntry[];
  notes?: string;
}

export interface ClientPerson {
  id: string;
  name: string;
  title: string;
  email?: string;
  phone?: string;
  role?: string;
  lastContact?: string;
}

/** Small Business Classification flags (Company Info wizard step 1). */
export interface SbClassification {
  sb?: boolean;
  wosb?: boolean;
  sdvosb?: boolean;
  hubzone?: boolean;
  eightA?: boolean;
  large?: boolean;
  foreignOwned?: boolean;
}

export interface ClientIntakeData extends Record<string, unknown> {
  sector?: string;
  trl?: string | number;
  fundingAsk?: string;
  /** Concrete projects or outcomes the client is seeking funding for. */
  fundingPriorities?: string[];
  requestType?: string;
  peNumber?: string;
  engagement?: string;
  portfolio?: string[];
  tags?: string[];
  documents?: ClientDocument[];
  governmentHistory?: Record<string, unknown>;
  address1?: string;
  address2?: string;
  city?: string;
  state?: string;
  country?: string;
  zip?: string;
  pocName?: string;
  pocTitle?: string;
  pocPhone?: string;
  pocEmail?: string;
  headName?: string;
  headTitle?: string;
  cageCode?: string;
  uei?: string;
  primaryNaics?: string;
  samStatus?: string;
  existingContracts?: string;
  capabilities?: Capability[];
  people?: ClientPerson[];
  // Company Info wizard additions (Company Info v3). These ride in the existing
  // intakeData JSON blob; no Prisma migration. See ClientFormModal for the form.
  dba?: string;
  sbClassification?: SbClassification;
  samExpirationDate?: string;
  additionalNaics?: string;
  ldaRegistrantName?: string;
  ein?: string;
  /** All selected sector labels (multi-select). The primary (first) is mirrored to Client.sectorTag. */
  sectors?: string[];
  engagementStartDate?: string;
  /** Internal notes — distinct from the Quick Log `profileNotes` append feature. */
  internalNotes?: string;
}

export interface ClientDocument {
  name: string;
  type?: string;
  date?: string;
}

export interface Client {
  id: string;
  name: string;
  website: string | null;
  description: string | null;
  productDescription: string | null;
  primaryContactName: string | null;
  primaryContactEmail: string | null;
  primaryContactPhone: string | null;
  logoS3Key: string | null;
  logoContentType: string | null;
  logoUploadedAt: string | null;
  logoUrl?: string | null;
  intakeData: ClientIntakeData | null;
  status: string;
  // Portfolio v2 additions, controlled vocab (see @capiro/shared).
  sectorTag?: string | null;
  profileType?: string | null;
  profileStatus?: string | null;
  submissionTracks?: string[];
  /** Manual client-level LDA issue-code override; unioned with the LDA-match codes for matching. */
  issueCodes?: string[];
  // Step 2.3 — first-class government identifiers used by the client ⇄ PE relevance engine.
  uei?: string | null;
  cageCode?: string | null;
  naicsCodes?: string[];
  pscCodes?: string[];
  /** Grants.gov "Eligible Applicants" label strings — see GRANTS_GOV_APPLICANT_TYPES. */
  applicantTypes?: string[];
  setAsideCertifications?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ClientPayload {
  name: string;
  website?: string;
  description?: string;
  productDescription?: string;
  primaryContactName?: string;
  primaryContactEmail?: string;
  primaryContactPhone?: string;
  intakeData?: Record<string, unknown>;
  sectorTag?: string | null;
  profileType?: string | null;
  profileStatus?: string | null;
  submissionTracks?: string[];
  issueCodes?: string[];
  // Step 2.3 — first-class government identifiers (relevance matching).
  uei?: string | null;
  cageCode?: string | null;
  naicsCodes?: string[];
  pscCodes?: string[];
  /** Grants.gov "Eligible Applicants" label strings — see GRANTS_GOV_APPLICANT_TYPES. */
  applicantTypes?: string[];
  setAsideCertifications?: string[];
}

export interface ClientAttachment {
  id: string;
  clientId: string | null;
  meetingId: string | null;
  mailMessageId: string | null;
  fileName: string;
  contentType: string;
  byteSize: number | null;
  source: string;
  createdAt: string;
  downloadUrl: string | null;
  /**
   * A second, `inline`-disposition presigned URL for the Files tab's preview
   * modal — null unless the file is one of a narrow, server-allowlisted set
   * of safe-to-render-inline content types (PDF, PNG, JPEG, GIF, WEBP).
   * Everything else (docx, xlsx, msg, svg, …) is null here on purpose; the
   * preview modal falls back to "no preview — download to view" and still
   * uses the unchanged, always-`attachment` downloadUrl above for that.
   */
  previewUrl?: string | null;
  // Meetings v2: stamped when client-KB indexing completes (drives the per-file
  // "Indexed" badge); uploader for attribution. All nullable / additive.
  indexedAt: string | null;
  /** Extraction/indexing describe different facts; indexedAt alone never
   * establishes that the file's contents are readable. */
  extractionStatus?: 'pending' | 'extracted' | 'truncated' | 'empty' | 'failed' | null;
  extractionMetadata?: Record<string, unknown> | null;
  uploadedByUserId: string | null;
  uploadedByName: string | null;
  /** Client CRM organization metadata; null means the attachment is unfiled. */
  folder?: string | null;
  /**
   * Who on the tenant may view this file in the client Files tab.
   * 'all' (default) = every member; 'restricted' = only viewerUserIds (+ uploader).
   * Additive — older payloads omit both and are treated as 'all'.
   */
  viewerMode?: 'all' | 'restricted';
  viewerUserIds?: string[];
}

export interface ClientFormValues {
  name?: string;
  website?: string;
  description?: string;
  productDescription?: string;
  /** Company contact block (step 1 as of the 2026-08-23 cleanup — formerly its own step). */
  primaryContactName?: string;
  primaryContactEmail?: string;
  primaryContactPhone?: string;
  /**
   * Multi-select sector labels. Stored in intakeData.sectors; the first
   * selected is mapped to the controlled Client.sectorTag for the intelligence
   * engine. See SECTOR_TAGS in @capiro/shared.
   */
  sectors?: string[];
  /** Controlled SubmissionTrack[], see SUBMISSION_TRACKS in @capiro/shared. */
  submissionTracks?: string[];
  /** Manual client-level LDA issue-code override (matching). */
  issueCodes?: string[];
  /** Controlled ProfileType, see PROFILE_TYPES in @capiro/shared. */
  profileType?: string;
  /** Controlled ProfileStatus, see PROFILE_STATUSES in @capiro/shared. */
  profileStatus?: string;
  // Small Business Classification flags (step 1)
  sbSb?: boolean;
  sbWosb?: boolean;
  sbSdvosb?: boolean;
  sbHubzone?: boolean;
  sbEightA?: boolean;
  sbLarge?: boolean;
  sbForeignOwned?: boolean;
  // Gov't registration (step 2)
  cageCode?: string;
  uei?: string;
  samStatus?: string;
  samExpirationDate?: string;
  ldaRegistrantName?: string;
  ein?: string;
  // Step 2.3 — first-class NAICS / PSC code lists for relevance matching (tag inputs).
  naicsCodes?: string[];
  pscCodes?: string[];
  /** Grants.gov "Eligible Applicants" label strings — see GRANTS_GOV_APPLICANT_TYPES. */
  applicantTypes?: string[];
  setAsideCertifications?: string[];
  // Sector & tracks (step 3)
  fundingPriorities?: string[];
  engagementStartDate?: string;
  internalNotes?: string;
  // ── Legacy fields retained for back-compat reads elsewhere in the app.
  //    No longer collected by the wizard (removed 2026-08-23: DBA/trade name
  //    had exactly one downstream reader and `name` is the functional field;
  //    address fields have no consumer — District Nexus geo-relevance reads
  //    Facility.state, not these; primaryNaics/additionalNaics were a
  //    free-text duplicate of the first-class naicsCodes[] above). Pre-existing
  //    intakeData for these keys is preserved on save (see
  //    formValuesToClientPayload), just no longer editable through this form. ──
  dba?: string;
  address1?: string;
  address2?: string;
  city?: string;
  state?: string;
  country?: string;
  zip?: string;
  primaryNaics?: string;
  additionalNaics?: string;
  trl?: string;
  fundingAsk?: string;
  requestType?: string;
  peNumber?: string;
  engagement?: string;
  portfolioText?: string;
  priorContracts?: string;
  grants?: string;
  priorEngagement?: string;
  pocName?: string;
  pocTitle?: string;
  pocPhone?: string;
  pocEmail?: string;
  headName?: string;
  headTitle?: string;
}

export interface ClientFormSubmit {
  payload: ClientPayload;
  documents: File[];
  logo?: File;
}
