/** Bounded dependency passes over stable reconciliation ordering. */
export async function applyRequestedItems(svc, ctx, run, requestedKinds) {
  const kinds = new Set(requestedKinds);
  for (const folderPass of [true, false]) {
    let offset = 0;
    do {
      const page = await svc.reconcile(ctx, run.id, offset);
      const itemIds = page.items
        .filter(
          (i) =>
            kinds.has(i.kind) &&
            (i.kind === 'folder') === folderPass &&
            ['ready', 'retry'].includes(i.status),
        )
        .map((i) => i.id);
      if (itemIds.length)
        await svc.apply(ctx, run.id, {
          targetTenantId: ctx.tenantId,
          mappingHash: run.mappingHash,
          itemIds,
        });
      offset = page.nextOffset;
    } while (offset !== null);
  }
}
