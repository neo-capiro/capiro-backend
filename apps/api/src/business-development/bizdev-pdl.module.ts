import { Module } from '@nestjs/common';
import { BizDevPdlAdapter } from './bizdev-pdl.adapter.js';

/**
 * People Data Labs (PDL) adapter module.
 *
 * Registers the BizDevPdlAdapter service for company and people enrichment.
 * The adapter uses ConfigService to retrieve the PDL API key which is injected
 * as an environment variable 'AWS_SECRET.ppl_datalabs' via AWS Secrets Manager.
 *
 * The secret ARN is:
 *   arn:aws:secretsmanager:us-east-1:967807252336:secret:ppl-datalabs-8EG2Qd
 *
 * Fail-soft: if the secret is missing or the API key is invalid, the adapter
 * logs a warning and returns 'error' or 'empty_in_queried_scope' statuses
 * without breaking the calling service.
 */
@Module({
  providers: [
    BizDevPdlAdapter,
    { provide: 'BIZDEV_PDL_ADAPTER', useExisting: BizDevPdlAdapter },
  ],
  exports: [BizDevPdlAdapter, 'BIZDEV_PDL_ADAPTER'],
})
export class BizDevPdlModule {}
