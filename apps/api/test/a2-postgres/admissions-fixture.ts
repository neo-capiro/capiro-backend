import { ClientsService } from '../../src/clients/clients.service.js';
import { FirmOnboardingService } from '../../src/intelligence/firm-onboarding.service.js';
import { BusinessDevelopmentService } from '../../src/business-development/business-development.service.js';
import { fixture, id, tenant } from './fixture.js';

export const prospect = id(101),
  otherProspect = id(102),
  archivedClient = id(103);
export async function admissionsFixture() {
  const h = await fixture('admissions');
  const provider = {
    resolveClient: async () => ({}),
    prepopulate: async () => ({}),
    enrichGovIds: async () => ({}),
    indexClientProfileFireAndForget: () => {},
  };
  const clients = (enforced = true) =>
    new ClientsService(
      h.prisma,
      { get: (key: string) => (key === 'BILLING_ENFORCED' ? enforced : undefined) } as never,
      provider as never,
      provider as never,
      provider as never,
      provider as never,
    );
  const clientService = clients();
  return {
    ...h,
    clients: clientService,
    unenforcedClients: clients(false),
    firm: new FirmOnboardingService(
      h.prisma,
      provider as never,
      provider as never,
      { get: () => true } as never,
    ),
    prospects: new BusinessDevelopmentService(
      h.prisma,
      clientService,
      provider as never,
      provider as never,
      provider as never,
    ),
    reset: async () => {
      await h.reset();
      await h.sql('TRUNCATE lda_filing,lda_client');
      await h.sql(
        `INSERT INTO lda_client(id,name) VALUES(10,'Synthetic LDA ten'),(11,'Synthetic LDA eleven')`,
      );
      await h.sql(
        `INSERT INTO lda_filing(registrant_id,client_id) VALUES(7,10),(7,11)`,
      );
      await h.sql(
        `INSERT INTO business_development_prospects(id,tenant_id,display_name,updated_at) VALUES($1,$3,'Synthetic first',$4),($2,$3,'Synthetic second',$4)`,
        [prospect, otherProspect, tenant, '2026-10-23T00:00:00.000Z'],
      );
      await h.sql(
        `INSERT INTO clients(id,tenant_id,name,status) VALUES($1,$2,'Synthetic archived','archived')`,
        [archivedClient, tenant],
      );
    },
  };
}
