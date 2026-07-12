/**
 * Read-only diagnostic: dump one state legislator's full profile exactly as
 * the State Legislators directory tab's detail endpoint
 * (GET /api/explorer/state-legislators/:id, explorer.service.ts
 * stateLegislatorDetail) computes it — identity, committees (relational
 * state_committee_membership), and sponsored bills (state_bill_sponsor joined
 * by legiscan_people_id). Mirrors that method's logic directly rather than
 * going through HTTP, since this table carries no tenant/RLS (global
 * reference data, same as congress_member) — no bypassRls needed.
 *
 *   diag-state-legislator-detail --id <state_legislator.id>
 *   diag-state-legislator-detail --name "<substring>" --state VA
 *   diag-state-legislator-detail                          # first crosswalked legislator found, any state
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const id = arg('id');
  const name = arg('name');
  const state = arg('state');

  const legislator = id
    ? await prisma.stateLegislator.findUnique({ where: { id } })
    : await prisma.stateLegislator.findFirst({
        where: {
          ...(name ? { name: { contains: name, mode: 'insensitive' } } : {}),
          ...(state ? { state: state.toUpperCase() } : {}),
          ...(name ? {} : { legiscanPeopleId: { not: null } }), // default: pick one with real bill data to show
        },
        orderBy: [{ state: 'asc' }, { name: 'asc' }],
      });

  if (!legislator) {
    console.log('No matching legislator found.');
    return;
  }

  const committeeRows = await prisma.stateCommitteeMembership.findMany({
    where: { legislatorId: legislator.id },
    include: { committee: true },
  });

  let sponsoredBills: unknown[] = [];
  let sponsoredBillsTotal = 0;
  if (legislator.legiscanPeopleId != null) {
    const [rows, count] = await Promise.all([
      prisma.stateBillSponsor.findMany({
        where: { legiscanPeopleId: legislator.legiscanPeopleId },
        include: {
          bill: { select: { id: true, identifier: true, title: true, status: true, statusAt: true } },
        },
        orderBy: [{ bill: { statusAt: { sort: 'desc', nulls: 'last' } } }],
        take: 10,
      }),
      prisma.stateBillSponsor.count({ where: { legiscanPeopleId: legislator.legiscanPeopleId } }),
    ]);
    sponsoredBills = rows.map((s) => ({
      identifier: s.bill.identifier,
      title: s.bill.title.slice(0, 80),
      status: s.bill.status,
      statusAt: s.bill.statusAt?.toISOString().slice(0, 10) ?? null,
      sponsorType: s.sponsorType,
    }));
    sponsoredBillsTotal = count;
  }

  console.log(
    JSON.stringify(
      {
        id: legislator.id,
        name: legislator.name,
        state: legislator.state,
        chamber: legislator.chamber,
        district: legislator.district,
        party: legislator.party,
        email: legislator.email,
        legiscanPeopleId: legislator.legiscanPeopleId,
        committeesFound: committeeRows.length,
        committees: committeeRows.map((c) => ({ name: c.committee.name, role: c.role })),
        sponsoredBillsTotal,
        sponsoredBillsSample: sponsoredBills,
      },
      null,
      2,
    ),
  );
}

if (require.main === module) {
  main()
    .catch((e) => {
      console.error(e);
      process.exit(1);
    })
    .finally(() => prisma.$disconnect());
}
