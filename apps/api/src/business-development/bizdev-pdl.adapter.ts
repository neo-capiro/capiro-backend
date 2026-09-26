import { Injectable, Logger } from '@nestjs/common';


/**
 * People Data Labs (PDL) HTTP adapter for company and person enrichment.
 *
 * Fail-soft by contract: a caller always receives a result object; this class
 * never throws. A missing or invalid API key, a 429 rate limit, or network
 * failure returns an error status with a user-safe message.
 *
 * PDL company enrichment:
 *   GET /v5/company/enrich?website=<domain>&fields=name,industry,sector,...
 *   Or: GET /v5/company/enrich?name=<company_name>&fields=...
 * PDL person enrichment:
 *   POST /v5/person/enrich with { website, company, role, title } payload
 *
 * Auth: X-Api-Key header
 * Docs: https://docs.peopledatalabs.com/docs/company-enrichment-api
 *
 * ── Secrets ──────────────────────────────────────────────────────────────────
 *
 * The API key is loaded from AWS Secrets Manager as 'ppl-datalabs' ARN:
 *   arn:aws:secretsmanager:us-east-1:967807252336:secret:ppl-datalabs-8EG2Qd
 *
 * The secret is injected as an environment variable 'AWS_SECRET.ppl_datalabs'
 * via ECS Secret.fromSecretsManager in the compute-stack.ts task definition.
 * The ConfigService reads this env var at startup.
 */

interface PdlCompanyRecord {
  name?: string;
  industry?: string;
  sector?: string;
  employee_count?: number;
  founded?: number;
  location?: { city?: string; state?: string; country?: string; formatted?: string };
  description?: string;
  linkedin_url?: string;
  tags?: string[];
  website?: string;
}

interface PdlPersonRecord {
  name?: string;
  title?: string;
  linkedin_url?: string;
  location?: { city?: string; state?: string; country?: string; formatted?: string };
  current_position?: {
    company?: { name?: string };
    title?: string;
    start?: string;
  };
  verified_positions?: Array<{
    company?: { name?: string };
    title?: string;
    start?: string;
    end?: string;
    verified?: boolean;
  }>;
}

interface PdlCompanyEnrichmentResponse {
  status: number;
  data?: PdlCompanyRecord;
  error?: string;
}

interface PdlPersonEnrichmentResponse {
  status: number;
  data?: PdlPersonRecord[];
  error?: string;
}

/** Company enrichment result shape exposed to the dossier service. */
export interface PdlCompanyEnrichment {
  name: string | null;
  industry: string | null;
  sector: string | null;
  employeeCount: number | null;
  founded: number | null;
  location: string | null;
  description: string | null;
  linkedinUrl: string | null;
  tags: string[];
  lastSeen: string; // when Capiro fetched this
}

/** Person enrichment result shape exposed to the dossier service. */
export interface PdlPersonResult {
  name: string | null;
  title: string | null;
  linkedinUrl: string | null;
  companyName: string | null;
  lastSeen: string; // when Capiro fetched this
}

export type PdlEnrichmentStatus = 'available' | 'empty_in_queried_scope' | 'error';

/** Company enrichment result envelope. */
export interface PdlCompanyEnrichmentResult {
  status: PdlEnrichmentStatus;
  data?: PdlCompanyEnrichment;
  error?: string;
}

/** Person enrichment result envelope. */
export interface PdlPersonEnrichmentResult {
  status: PdlEnrichmentStatus;
  data?: PdlPersonResult[];
  error?: string;
}

const PDL_COMPANY_BASE_URL = 'https://api.peopledatalabs.com/v5/company/enrich';
const PDL_PERSON_BASE_URL = 'https://api.peopledatalabs.com/v5/person/enrich';
const PDL_TIMEOUT_MS = 10_000;

// Fields requested for company enrichment
const COMPANY_FIELDS = [
  'name',
  'industry',
  'sector',
  'employee_count',
  'founded',
  'location',
  'description',
  'linkedin_url',
  'tags',
  'website',
].join(',');

// Max results returned for person enrichment
const PERSON_RESULT_CAP = 5;

@Injectable()
export class BizDevPdlAdapter {
  private readonly logger = new Logger(BizDevPdlAdapter.name);
  private readonly apiKey?: string;
  private readonly enabled: boolean;

  constructor() {
    // PDL API key is loaded from environment variable PDL_API_KEY,
    // injected via AWS Secrets Manager in the ECS task definition.
    // When missing or empty, enrichment is unavailable (fail-soft).
    const rawKey = process.env.PDL_API_KEY ?? '';
    this.apiKey = rawKey.trim() || undefined;
    this.enabled = !!this.apiKey;

    if (!this.enabled) {
      this.logger.warn(
        'People Data Labs (PDL) is not configured (no API key). Company and people enrichment are unavailable.',
      );
    }
  }

  get configured(): boolean {
    return this.enabled;
  }

  /**
   * Enrich a company by website domain.
   * Returns a single company record or an error status.
   */
  async enrichCompany(domain: string): Promise<PdlCompanyEnrichmentResult> {
    if (!this.enabled) {
      return {
        status: 'error',
        error: 'People Data Labs (PDL) is not configured (no API key).',
      };
    }

    const cleanDomain = domain.trim().toLowerCase();
    if (!cleanDomain.includes('.')) {
      return {
        status: 'empty_in_queried_scope',
        error: `"${domain}" is not a valid domain.`,
      };
    }

    const url = new URL(PDL_COMPANY_BASE_URL);
    url.searchParams.set('website', cleanDomain);
    url.searchParams.set('fields', COMPANY_FIELDS);

    try {
      const response = await this.httpGet(url.toString());

      if (response.status === 401 || response.status === 403) {
        this.logger.error('PDL authentication failed (invalid or revoked API key).');
        return {
          status: 'error',
          error: 'People Data Labs authentication failed. Please check your API key.',
        };
      }

      if (response.status === 429) {
        this.logger.warn('PDL rate limit exceeded.');
        return {
          status: 'error',
          error: 'People Data Labs is rate limiting requests. Please try again later.',
        };
      }

      if (response.status === 404) {
        this.logger.log(`PDL company not found for domain "${cleanDomain}".`);
        return {
          status: 'empty_in_queried_scope',
          error: `No company found for domain "${cleanDomain}".`,
        };
      }

      if (response.status < 200 || response.status >= 300) {
        this.logger.error(`PDL company enrichment failed with status ${response.status}.`);
        return {
          status: 'error',
          error: `People Data Labs returned an error (status ${response.status}).`,
        };
      }

      const data = response.data;
      if (!data) {
        this.logger.log(`PDL company enrichment returned no data for domain "${cleanDomain}".`);
        return {
          status: 'empty_in_queried_scope',
          error: `No company data returned for domain "${cleanDomain}".`,
        };
      }

      const record = data;
      const fetchedAt = new Date().toISOString();

      return {
        status: 'available',
        data: {
          name: record.name ?? null,
          industry: record.industry ?? null,
          sector: record.sector ?? null,
          employeeCount: record.employee_count ?? null,
          founded: record.founded ?? null,
          location: this.formatLocation(record.location),
          description: record.description ?? null,
          linkedinUrl: record.linkedin_url ?? null,
          tags: Array.isArray(record.tags) ? record.tags : [],
          lastSeen: fetchedAt,
        },
      };
    } catch (error) {
      this.logger.error(
        `PDL company enrichment request failed for domain "${cleanDomain}": ${this.getErrorText(error)}`,
      );
      return {
        status: 'error',
        error: 'People Data Labs request failed. Please try again later.',
      };
    }
  }

  /**
   * Enrich people by company domain and optional role/title keywords.
   * Returns up to PERSON_RESULT_CAP person records.
   */
  async enrichPeople(
    domain: string,
    kwargs?: {
      role?: string;
      title?: string;
    },
  ): Promise<PdlPersonEnrichmentResult> {
    if (!this.enabled) {
      return {
        status: 'error',
        error: 'People Data Labs (PDL) is not configured (no API key).',
      };
    }

    const cleanDomain = domain.trim().toLowerCase();
    if (!cleanDomain.includes('.')) {
      return {
        status: 'empty_in_queried_scope',
        error: `"${domain}" is not a valid domain.`,
      };
    }

    const payload: Record<string, string> = { website: cleanDomain };
    if (kwargs?.role) {
      payload.role = kwargs.role.trim().toLowerCase();
    }
    if (kwargs?.title) {
      payload.title = kwargs.title.trim().toLowerCase();
    }

    try {
      const response = await this.httpPost(PDL_PERSON_BASE_URL, payload);

      if (response.status === 401 || response.status === 403) {
        this.logger.error('PDL authentication failed (invalid or revoked API key).');
        return {
          status: 'error',
          error: 'People Data Labs authentication failed. Please check your API key.',
        };
      }

      if (response.status === 429) {
        this.logger.warn('PDL rate limit exceeded.');
        return {
          status: 'error',
          error: 'People Data Labs is rate limiting requests. Please try again later.',
        };
      }

      if (response.status === 404) {
        this.logger.log(`PDL person not found for domain "${cleanDomain}".`);
        return {
          status: 'empty_in_queried_scope',
          error: `No people found for domain "${cleanDomain}".`,
        };
      }

      if (response.status < 200 || response.status >= 300) {
        this.logger.error(`PDL person enrichment failed with status ${response.status}.`);
        return {
          status: 'error',
          error: `People Data Labs returned an error (status ${response.status}).`,
        };
      }

      const data = response.data;
      if (!data || !Array.isArray(data)) {
        this.logger.log(`PDL person enrichment returned no data for domain "${cleanDomain}".`);
        return {
          status: 'empty_in_queried_scope',
          error: `No people data returned for domain "${cleanDomain}".`,
        };
      }

      const fetchedAt = new Date().toISOString();
      const results: PdlPersonResult[] = data
        .slice(0, PERSON_RESULT_CAP)
        .map((record: PdlPersonRecord) => ({
          name: record.name ?? null,
          title: record.title ?? null,
          linkedinUrl: record.linkedin_url ?? null,
          companyName: record.current_position?.company?.name ?? null,
          lastSeen: fetchedAt,
        }));

      if (results.length === 0) {
        return {
          status: 'empty_in_queried_scope',
          error: `No people found for domain "${cleanDomain}".`,
        };
      }

      return {
        status: 'available',
        data: results,
      };
    } catch (error) {
      this.logger.error(
        `PDL person enrichment request failed for domain "${cleanDomain}": ${this.getErrorText(error)}`,
      );
      return {
        status: 'error',
        error: 'People Data Labs request failed. Please try again later.',
      };
    }
  }

  // ── HTTP helpers (internal) ────────────────────────────────────────────────

  /**
   * Performs a GET request to the PDL API with timeout and error handling.
   * Uses dynamic import to support ESM-only @pdl/sdk if added later.
   */
  private async httpGet(url: string): Promise<PdlCompanyEnrichmentResponse> {
    // Use native fetch with built-in timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), PDL_TIMEOUT_MS);

    try {
      const headers: Record<string, string> = { 'X-Api-Key': this.apiKey ?? '' };

      const response = await fetch(url, {
        method: 'GET',
        headers,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (response.ok) {
        return { status: response.status, data: (await response.json()) as PdlCompanyRecord };
      }

      // Read error body for better diagnostics
      let errorText = '';
      try {
        const body = await response.text();
        if (body) {
          errorText = JSON.parse(body)?.message ?? body;
        }
      } catch {
        // Ignore parse errors
      }

      return { status: response.status, error: errorText || `HTTP ${response.status}` };
    } catch (error: unknown) {
      clearTimeout(timeoutId);

      if (error instanceof Error && error.name === 'AbortError') {
        this.logger.error(`PDL company enrichment request timed out after ${PDL_TIMEOUT_MS}ms.`);
        return {
          status: 408,
          error: 'Request timeout',
        };
      }

      throw error;
    }
  }

  /**
   * Performs a POST request to the PDL API with timeout and error handling.
   */
  private async httpPost(url: string, payload: Record<string, string>): Promise<PdlPersonEnrichmentResponse> {
    const controller = new AbortController();
    const timeoutId = new AbortController();
    const timeoutSignal = timeoutId.signal;

    // Set up a timer to abort after PDL_TIMEOUT_MS
    const timeoutTimer = setTimeout(() => timeoutId.abort(), PDL_TIMEOUT_MS);

    try {
      const headers: Record<string, string> = {
        'X-Api-Key': this.apiKey ?? '',
        'Content-Type': 'application/json',
      };

      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: timeoutSignal,
      });

      clearTimeout(timeoutTimer);

      if (response.ok) {
        const json = (await response.json()) as { data?: PdlPersonRecord[] };
        return { status: response.status, data: json.data };
      }

      // Read error body for better diagnostics
      let errorText = '';
      try {
        const body = await response.text();
        if (body) {
          errorText = JSON.parse(body)?.message ?? body;
        }
      } catch {
        // Ignore parse errors
      }

      return { status: response.status, error: errorText || `HTTP ${response.status}` };
    } catch (error: unknown) {
      clearTimeout(timeoutTimer);

      if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
        this.logger.error(`PDL person enrichment request timed out after ${PDL_TIMEOUT_MS}ms.`);
        return {
          status: 408,
          error: 'Request timeout',
        };
      }

      throw error;
    }
  }

  /**
   * Formats a PDL location object into a human-readable string.
   */
  private formatLocation(location?: {
    city?: string;
    state?: string;
    country?: string;
    formatted?: string;
  }): string | null {
    if (!location) return null;
    if (location.formatted) return location.formatted;

    const parts = [location.city, location.state, location.country].filter(Boolean);
    return parts.length > 0 ? parts.join(', ') : null;
  }

  /**
   * Extracts a safe error message from anunknown error object.
   */
  private getErrorText(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    if (typeof error === 'object' && error !== null && 'message' in error) {
      return String(error.message);
    }
    return String(error);
  }
}
