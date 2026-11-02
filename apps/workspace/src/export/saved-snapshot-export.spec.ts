import 'reflect-metadata';
import { SavedSnapshotExportService, SAVED_SNAPSHOT_EXPORT_MAX_BYTES } from './saved-snapshot-export.service.js';
import { ExportController } from './export.controller.js';
import { TenantGuard } from '../auth/tenant.guard.js';
import type { VersionsService } from '../versions/versions.service.js';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function fixture() {
  const row = { id: id(3), tenantId: id(1), draftId: id(2), label: 'Saved copy',
    authorId: 'user_owner', authorKind: 'person', createdAt: new Date('2026-10-29T00:00:00Z'),
    snapshot: { prospectId: id(4), documents: [{id:id(5),body:{blocks:[{type:'table',cells:[[{text:'Preserve',span:2}]]}],extra:{nested:true}}}], sourceEvidence:{citations:[]}}
  };
  const getSaved = jest.fn(async () => row);
  const service = new SavedSnapshotExportService({ getSaved } as unknown as VersionsService);
  return { row, getSaved, service, read: () => service.read(id(1),id(2),id(3),'user_reader') };
}
it('preserves all saved rich JSON and provenance and delegates exact current authority', async () => {
  const h=fixture(),result=await h.read();
  expect(result.snapshot).toEqual(h.row.snapshot);
  expect(h.getSaved).toHaveBeenCalledWith(id(1),id(2),id(3),'user_reader');
  expect(result.createdAt).toBe('2026-10-29T00:00:00.000Z');
});
it.each(['id','tenantId','draftId'] as const)('refuses mismatched %s before export',async key=>{
  const h=fixture();h.row[key]=id(99);await expect(h.read()).rejects.toMatchObject({status:404});
});
it('refuses oversized serialized JSON without truncating fields',async()=>{
  const h=fixture();Object.assign(h.row.snapshot,{huge:'x'.repeat(SAVED_SNAPSHOT_EXPORT_MAX_BYTES)});
  await expect(h.read()).rejects.toMatchObject({status:413});
});
it('routes explicit snapshot exports through the existing authenticated export controller with no caching',()=>{
  expect(Reflect.getMetadata('__guards__',ExportController)).toContain(TenantGuard);
  expect(Reflect.getMetadata('path',ExportController.prototype.snapshot)).toBe('snapshot/:versionId');
  expect(Reflect.getMetadata('__headers__',ExportController.prototype.snapshot)).toEqual(expect.arrayContaining([
    {name:'Cache-Control',value:'private, no-store'},
    {name:'Content-Disposition',value:'attachment; filename="workspace-saved-version.json"'}
  ]));
});

