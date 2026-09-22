import type { Prisma } from '@prisma/client';

export type BudgetLineLineage = {
  relType: string;
  status: 'accepted' | 'candidate';
  fromCode: string;
  toCode: string;
  transitionFyFrom: number | null;
  transitionFyTo: number | null;
  evidence: Prisma.JsonValue;
};

type LineagePrisma = {
  budgetLineRelationship: Pick<Prisma.BudgetLineRelationshipDelegate, 'findMany'>;
};

export async function listBudgetLineLineage(
  prisma: LineagePrisma,
  identity: { peCode?: string; blin?: string },
): Promise<BudgetLineLineage[]> {
  const code = (identity.peCode ?? identity.blin)?.trim().toUpperCase();
  if (!code) return [];

  const rows = await prisma.budgetLineRelationship.findMany({
    where: {
      relType: { in: ['predecessor_successor', 'same_program'] },
      status: { in: ['accepted', 'candidate'] },
      OR: [{ fromPeCode: code }, { toPeCode: code }],
    },
    orderBy: [{ status: 'asc' }, { relType: 'asc' }, { fromPeCode: 'asc' }, { toPeCode: 'asc' }],
    select: {
      relType: true,
      status: true,
      fromPeCode: true,
      toPeCode: true,
      transitionFyFrom: true,
      transitionFyTo: true,
      evidenceJson: true,
    },
  });

  return rows.map((row) => ({
    relType: row.relType,
    status: row.status as 'accepted' | 'candidate',
    fromCode: row.fromPeCode,
    toCode: row.toPeCode,
    transitionFyFrom: row.transitionFyFrom,
    transitionFyTo: row.transitionFyTo,
    evidence: row.evidenceJson,
  }));
}