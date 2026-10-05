import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { detectAttachmentKind } from './meri-attachment.helpers.js';

// pptx (PR #1604) and xlsx were both added to the application's attachment
// kinds without widening the database constraint, so every upload of that kind
// failed at insert time. Keep the latest constraint in step with the kinds the
// upload path can store.
test('the clio_attachments kind constraint allows every storable attachment kind', () => {
  const root = join(__dirname, '../../prisma/migrations');
  const latest = readdirSync(root)
    .filter((dir) => existsSync(join(root, dir, 'migration.sql')))
    .sort()
    .map((dir) => readFileSync(join(root, dir, 'migration.sql'), 'utf8'))
    .filter((sql) => sql.includes('clio_attachments_kind_check') && /CHECK\s*\(\s*"kind"\s+IN/i.test(sql))
    .at(-1);
  expect(latest).toBeDefined();
  const allowed = [...latest!.matchAll(/CHECK\s*\(\s*"kind"\s+IN\s*\(([^)]*)\)/gi)].at(-1)![1]!
    .split(',')
    .map((value) => value.trim().replace(/'/g, ''));
  const storable = [
    detectAttachmentKind('application/pdf', 'a.pdf'),
    detectAttachmentKind('', 'a.docx'),
    detectAttachmentKind('', 'a.pptx'),
    detectAttachmentKind('', 'a.xlsx'),
    detectAttachmentKind('image/png', 'a.png'),
    detectAttachmentKind('text/plain', 'a.txt'),
  ];
  expect(storable).toEqual(['pdf', 'docx', 'pptx', 'xlsx', 'image', 'text']);
  for (const kind of storable) expect(allowed).toContain(kind);
});
