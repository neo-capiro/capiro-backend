import { Module } from '@nestjs/common';
import { RepresentationResolverService } from '../clients/representation-resolver.service.js';
import { VendorReferenceController } from './vendor-reference.controller.js';
import { VendorReferenceSamClient } from './vendor-reference-sam.client.js';
import { VendorReferenceService } from './vendor-reference.service.js';

/**
 * Vendor Reference Pull. Read-only composition over existing rails:
 * SAM.gov entity lookup (live), USAspending / Tango award tables, Senate LDA
 * filings, and the congressional directory + committee rosters.
 *
 * RepresentationResolverService is provided here directly: it depends only on
 * the globally-exported PrismaService, and ClientsModule does not export it.
 * A second stateless instance is cheaper than importing the whole clients
 * module graph into a read-only reference surface.
 */
@Module({
  controllers: [VendorReferenceController],
  providers: [VendorReferenceService, VendorReferenceSamClient, RepresentationResolverService],
  exports: [VendorReferenceService],
})
export class VendorReferenceModule {}
