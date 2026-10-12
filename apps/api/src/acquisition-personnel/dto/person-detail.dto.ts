export interface PersonSourceMentionDto {
  id: string;
  source: string;
  sourceUrl: string | null;
  snippet: string | null;
  observedAt: string;
  confidence: number;
  metadata: unknown;
}

export interface PersonDetailDto {
  id: string;
  fullName: string;
  nameKey: string;
  service: string | null;
  organization: string | null;
  title: string | null;
  role: string | null;
  programOfRecord: string | null;
  pePrimary: string | null;
  peSecondary: string[];
  emailDomain: string | null;
  email: string | null;
  phone: string | null;
  parentOffice: string | null;
  department: string | null;
  publicProfileUrl: string | null;
  confidence: number;
  status: string;
  firstSeenAt: string;
  lastSeenAt: string;
  metadata: unknown;
  sources: PersonSourceMentionDto[];
}
