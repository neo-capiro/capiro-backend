import { resolveStateName } from '../../common/us-states.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { MemberPriorityIdentity } from './priority-intelligence-cpf-cds.js';

/** Include historical names when checking ambiguity; they never become current representatives. */
export async function loadPriorityMemberDirectory(
  prisma: PrismaService,
  stateCode: string,
): Promise<MemberPriorityIdentity[]> {
  const state = stateCode.trim().toUpperCase();
  const stateName = resolveStateName(state);
  if (!stateName) return [];
  const members = await prisma.congressMember.findMany({
    where: { state: stateName, chamber: { in: ['house', 'senate'] } },
    select: {
      bioguideId: true,
      fullName: true,
      firstName: true,
      lastName: true,
      chamber: true,
      district: true,
      isCurrent: true,
    },
    orderBy: { bioguideId: 'asc' },
  });
  return members.flatMap((member) =>
    member.chamber === 'house' || member.chamber === 'senate'
      ? [
          {
            ...member,
            chamber: member.chamber,
            state,
            district: member.district == null ? null : String(member.district),
          },
        ]
      : [],
  );
}
