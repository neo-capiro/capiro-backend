import type { PrismaClient } from '@prisma/client';

export interface CongressSubjectsResponse {
  subjects?: {
    legislativeSubjects?: { name?: unknown }[] | null;
    policyArea?: { name?: string } | null;
  } | null;
}

export interface CongressCommitteesResponse {
  committees?:
    | {
        activities?: { date?: string; name?: string }[];
        chamber?: unknown;
        name?: unknown;
        systemCode?: unknown;
        type?: unknown;
        url?: string;
      }[]
    | null;
}

export interface NormalizedCongressCommittee {
  name: string;
  chamber: string | null;
  type: string | null;
  systemCode: string | null;
}

export type CongressClassificationFetchResult<T> =
  { ok: true; data: T } | { ok: false; error: Error };

export interface AuthoritativeCongressClassifications {
  subjects?: string[];
  committees?: NormalizedCongressCommittee[];
}

export type CongressClassificationPrisma = Pick<PrismaClient, '$transaction'>;

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function optionalString(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new Error('expected a string or null');
  return value;
}

/** A missing/malformed payload is not an authoritative empty subject list. */
export async function fetchCongressSubjects(
  fetchSubjects: () => Promise<CongressSubjectsResponse | null>,
): Promise<CongressClassificationFetchResult<string[]>> {
  try {
    const response = await fetchSubjects();
    const items = response?.subjects?.legislativeSubjects;
    if (!Array.isArray(items)) {
      throw new Error('Congress subjects endpoint returned no valid legislativeSubjects array');
    }

    const subjects = items.map((item) => {
      if (typeof item?.name !== 'string' || item.name.trim() === '') {
        throw new Error('Congress subjects endpoint returned a malformed subject');
      }
      return item.name;
    });
    return { ok: true, data: subjects };
  } catch (error) {
    return { ok: false, error: asError(error) };
  }
}

/** A missing/malformed payload is not an authoritative empty committee list. */
export async function fetchCongressCommittees(
  fetchCommittees: () => Promise<CongressCommitteesResponse | null>,
): Promise<CongressClassificationFetchResult<NormalizedCongressCommittee[]>> {
  try {
    const response = await fetchCommittees();
    if (!Array.isArray(response?.committees)) {
      throw new Error('Congress committees endpoint returned no valid committees array');
    }

    const committees = response.committees.map((committee) => {
      if (typeof committee?.name !== 'string' || committee.name.trim() === '') {
        throw new Error('Congress committees endpoint returned a malformed committee');
      }
      return {
        name: committee.name,
        chamber: optionalString(committee.chamber),
        type: optionalString(committee.type),
        systemCode: optionalString(committee.systemCode),
      };
    });
    return { ok: true, data: committees };
  } catch (error) {
    return { ok: false, error: asError(error) };
  }
}

/** Failed/not-requested subresources are intentionally omitted, never coerced to empty. */
export function authoritativeCongressClassifications(
  subjects: CongressClassificationFetchResult<string[]> | null,
  committees: CongressClassificationFetchResult<NormalizedCongressCommittee[]> | null,
): AuthoritativeCongressClassifications {
  return {
    ...(subjects?.ok === true ? { subjects: subjects.data } : {}),
    ...(committees?.ok === true ? { committees: committees.data } : {}),
  };
}

/**
 * Replace only subresources whose upstream responses were authoritative. The
 * callback transaction keeps each requested delete/create set atomic.
 */
export async function replaceCongressBillClassificationsAtomically(
  prisma: CongressClassificationPrisma,
  billId: string,
  data: AuthoritativeCongressClassifications,
): Promise<void> {
  if (data.subjects === undefined && data.committees === undefined) return;

  await prisma.$transaction(async (tx) => {
    if (data.subjects !== undefined) {
      await tx.congressBillSubject.deleteMany({ where: { billId } });
      if (data.subjects.length > 0) {
        await tx.congressBillSubject.createMany({
          data: data.subjects.map((name) => ({ billId, name })),
        });
      }
    }

    if (data.committees !== undefined) {
      await tx.congressBillCommittee.deleteMany({ where: { billId } });
      if (data.committees.length > 0) {
        await tx.congressBillCommittee.createMany({
          data: data.committees.map((committee) => ({
            billId,
            committeeName: committee.name,
            committeeCode: committee.systemCode,
            chamber: committee.chamber,
          })),
        });
      }
    }
  });
}
