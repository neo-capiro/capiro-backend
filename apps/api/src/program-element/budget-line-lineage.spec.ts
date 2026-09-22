import { listBudgetLineLineage } from './budget-line-lineage.js';

describe('listBudgetLineLineage', () => {
  it('queries both directions and preserves accepted/candidate review status', async () => {
    const findMany = jest.fn().mockResolvedValue([
      {
        relType: 'predecessor_successor', status: 'accepted', fromPeCode: 'OLD', toPeCode: 'LINE',
        transitionFyFrom: 2026, transitionFyTo: 2027, evidenceJson: [{ file: 'old.md', locator: '10' }],
      },
      {
        relType: 'same_program', status: 'candidate', fromPeCode: 'LINE', toPeCode: 'OTHER',
        transitionFyFrom: null, transitionFyTo: null, evidenceJson: [{ file: 'other.md', locator: '20' }],
      },
    ]);

    const result = await listBudgetLineLineage({ budgetLineRelationship: { findMany } }, { blin: ' line ' });

    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        relType: { in: ['predecessor_successor', 'same_program'] },
        OR: [{ fromPeCode: 'LINE' }, { toPeCode: 'LINE' }],
      }),
    }));
    expect(result).toEqual([
      expect.objectContaining({ status: 'accepted', fromCode: 'OLD', toCode: 'LINE', transitionFyTo: 2027 }),
      expect.objectContaining({ status: 'candidate', fromCode: 'LINE', toCode: 'OTHER', transitionFyTo: null }),
    ]);
  });

  it('does not query without either identity', async () => {
    const findMany = jest.fn();
    await expect(listBudgetLineLineage({ budgetLineRelationship: { findMany } }, {})).resolves.toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });
});