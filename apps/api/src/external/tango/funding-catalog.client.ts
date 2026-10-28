import { TangoGatewayService } from './tango.client.js';
import { TangoError } from './tango.errors.js';
import type { TangoStoreService } from './tango-store.service.js';
import type { RecordData } from './funding-catalog.mapper.js';

export class CatalogQuotaPause extends Error {}
export const OPPORTUNITY_SHAPE = 'opportunity_id,title,solicitation_number,description,active,response_deadline,first_notice_date,last_notice_date,sam_url,office,naics_code,psc_code,set_aside,place_of_performance,primary_contact,meta,latest_notice_id,latest_notice,notice_history,attachments(attachment_id,resource_id,name,type,url,file_size,mime_type,posted_date,doc_role,extraction_status,extracted_text)';
export { GRANT_SHAPE } from './tango.shapes.js';

/** Sequential calls share the account's actual daily-remaining header. Stop
 * before using the reserve; no day-long sleep or hidden SDK retry. */
export class FundingCatalogClient {
  private gateway: TangoGatewayService;
  private remaining = Infinity;
  private issued = 0;
  private lastCallAt = 0;
  constructor(private store: TangoStoreService, private options: { maxRequests: number; reserve: number; commit: boolean; apiKey: string; fetchImpl?: typeof fetch }) {
    const transport = options.fetchImpl ?? fetch;
    this.gateway = new TangoGatewayService({ apiKey: options.apiKey, baseUrl: 'https://tango.dev', timeoutMs: 60_000,
      fetchImpl: async (input, init) => {
        const response = await transport(input, init);
        const header = response.headers.get('x-ratelimit-daily-remaining');
        if (header !== null && Number.isFinite(Number(header))) this.remaining = Number(header);
        return response;
      },
    });
  }
  async get(resource: 'grants' | 'notices' | 'opportunities', query: RecordData, id?: string): Promise<RecordData> {
    if (this.issued >= this.options.maxRequests || this.remaining <= this.options.reserve) throw new CatalogQuotaPause('Request budget reached; checkpoint retained');
    const delay = Math.max(0, 750 - (Date.now() - this.lastCallAt));
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    this.issued++;
    this.lastCallAt = Date.now();
    let status: 'success' | TangoError['kind'] = 'success';
    let rows: number | null = null;
    try {
      const result = await this.gateway.fundingCatalogGet(resource, query, id);
      rows = Array.isArray(result.results) ? result.results.length : 1;
      return result;
    } catch (error) {
      status = error instanceof TangoError ? error.kind : 'transient';
      if (status === 'rate_limit') throw new CatalogQuotaPause('Provider rate limit reached; checkpoint retained');
      throw error;
    } finally {
      if (this.options.commit) await this.store.recordUsage({ callFamily: `funding:${resource}`, status, rowCount: rows,
        durationMs: Date.now() - this.lastCallAt, rateLimitRemaining: Number.isFinite(this.remaining) ? this.remaining : null });
    }
  }
}
