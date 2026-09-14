import { PrismaService } from '../src/prisma/prisma.service.js';
import { StateSourceDataRepository } from '../src/sourcedata/state-source-data.repository.js';

describe('Historical research stays outside proactive state recommendations', () => {
  const prisma = new PrismaService();
  beforeAll(() => {
    if (process.env.LEGIWATCH_PHASE7_TEST_DATABASE !== 'disposable') {
      throw Error('Disposable Phase 7 database required');
    }
  });
  afterAll(() => prisma.$disconnect());
  it('keeps current regular and biennial sessions while excluding prior, unknown and other-state sessions', async () => {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        'CREATE TEMP TABLE state_session(state text,session_key text,prior boolean) ON COMMIT DROP',
      );
      await tx.$executeRawUnsafe(
        'CREATE TEMP TABLE state_bill(id text,state text,session_key text,subjects text[],title text) ON COMMIT DROP',
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO state_session VALUES ('FL','2026',false),('FL','2025',true),('TX','2025',false),('GA','2026',false)`,
      );
      await tx.$executeRawUnsafe(`INSERT INTO state_bill VALUES
        ('fl-current','FL','2026',ARRAY['health'],'Hospital licenses'),
        ('fl-history','FL','2025',ARRAY['health'],'Hospital licenses'),
        ('fl-unknown','FL','2024',ARRAY['health'],'Hospital licenses'),
        ('tx-biennial','TX','2025',ARRAY['health'],'Hospital licenses'),
        ('ga-other','GA','2026',ARRAY['health'],'Hospital licenses')`);
      const source = new StateSourceDataRepository(tx as unknown as PrismaService);
      expect((await source.stateKeywordCandidateIds(['health'], ['FL', 'TX'])).sort()).toEqual([
        'fl-current',
        'tx-biennial',
      ]);
      // Explicit historical research/detail still has the retained public row.
      const retained = await tx.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT id FROM state_bill WHERE state='FL' AND session_key='2025'`,
      );
      expect(retained.map((r) => r.id)).toEqual(['fl-history']);
    });
  });
});
