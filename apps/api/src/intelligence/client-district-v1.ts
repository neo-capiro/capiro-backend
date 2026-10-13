import type { PrismaService } from '../prisma/prisma.service.js';
import type { Prisma } from '@prisma/client';

type Capability = Prisma.ClientCapabilityGetPayload<{
  select: { id: true; name: true; sector: true; districtNexus: true; existingContracts: true };
}>;
type CapabilityDistricts = Array<{ cap: Capability; districtKeys: string[] }>;
type CensusDistrict = {
  id: string;
  congress: number;
  state: string;
  district: string;
  total_population: number | null;
  median_household_income: number | null;
  labor_force_size: number | null;
  unemployment_rate: number | null;
  percent_veteran: number | null;
  top_industries: unknown;
  data_year: number;
};

export class ClientDistrictV1 {
  constructor(private readonly prisma: PrismaService) {}

  async getDistrictNexus(clientId: string, tenantId: string) {
    const caps = await this.readCapabilities(clientId, tenantId);

    const { allKeys, capDistricts } = this.parseCapabilityDistricts(caps);

    if (!allKeys.length) {
      return {
        capabilities: caps.map((c) => ({
          capabilityId: c.id,
          capabilityName: c.name,
          capabilitySector: c.sector,
          districtNexus: c.districtNexus,
          districts: [],
          talkingPoints: [],
          totalSupportedJobs: null,
        })),
      };
    }

    const districtRows = await this.readCensusDistricts(allKeys);

    return this.projectCapabilityNexus(capDistricts, districtRows);
  }

  private readCapabilities(clientId: string, tenantId: string) {
    return this.prisma.withTenant(tenantId, (tx) =>
      tx.clientCapability.findMany({
        where: { clientId },
        select: {
          id: true,
          name: true,
          sector: true,
          districtNexus: true,
          existingContracts: true,
        },
      }),
    );
  }

  private parseCapabilityDistricts(caps: Capability[]) {
    const pattern = /\b([A-Z]{2})[\s\-\/]+(?:CD[\s\-]?)?(\d{1,3}|AL)\b/g;

    const allKeys: string[] = [];

    const capDistricts = caps.map((cap) => {
      const text = cap.districtNexus ?? '';
      const seen = new Set<string>();
      const districtKeys: string[] = [];
      let m: RegExpExecArray | null;
      while ((m = pattern.exec(text.toUpperCase())) !== null) {
        const state = m[1];
        const raw = m[2];
        if (!state || !raw) continue;
        const district = raw === 'AL' ? 'AL' : String(parseInt(raw, 10));
        const key = `${state}-${district}`;
        if (!seen.has(key)) {
          seen.add(key);
          districtKeys.push(key);
          allKeys.push(key);
        }
      }
      return { cap, districtKeys };
    });

    return { allKeys, capDistricts };
  }

  private readCensusDistricts(allKeys: string[]) {
    return this.prisma.$queryRaw<
      Array<{
        id: string;
        congress: number;
        state: string;
        district: string;
        total_population: number | null;
        median_household_income: number | null;
        labor_force_size: number | null;
        unemployment_rate: number | null;
        percent_veteran: number | null;
        top_industries: unknown;
        data_year: number;
      }>
    >`
      SELECT DISTINCT ON (state, district)
        id, congress, state, district, total_population, median_household_income,
        labor_force_size, unemployment_rate, percent_veteran, top_industries, data_year
      FROM census_district
      WHERE state || '-' || district = ANY(${allKeys}::text[])
      ORDER BY state, district, congress DESC
    `;
  }

  private projectCapabilityNexus(
    capDistricts: CapabilityDistricts,
    districtRows: CensusDistrict[],
  ) {
    const districtMap = new Map(districtRows.map((r) => [`${r.state}-${r.district}`, r]));

    const extractJobs = (value: string | null): number | null => {
      if (!value) return null;
      const m = value.match(/(\d[\d,]*)\s*(jobs?|employees?|workers?)/i);
      if (!m?.[1]) return null;
      const n = Number(m[1].replace(/,/g, ''));
      return Number.isFinite(n) ? n : null;
    };

    return {
      capabilities: capDistricts.map(({ cap, districtKeys }) => {
        const districts = districtKeys
          .map((key) => districtMap.get(key))
          .filter((d): d is NonNullable<typeof d> => Boolean(d))
          .map((d) => ({
            id: d.id,
            congress: d.congress,
            state: d.state,
            district: d.district,
            totalPopulation: d.total_population,
            medianHouseholdIncome: d.median_household_income,
            laborForceSize: d.labor_force_size,
            unemploymentRate: d.unemployment_rate,
            percentVeteran: d.percent_veteran,
            topIndustries: Array.isArray(d.top_industries) ? d.top_industries : [],
            dataYear: d.data_year,
          }));

        const explicitJobs =
          extractJobs(cap.existingContracts ?? null) ?? extractJobs(cap.districtNexus ?? null);
        const jobsPerDistrict =
          explicitJobs != null
            ? Math.max(1, Math.round(explicitJobs / Math.max(districts.length, 1)))
            : null;
        const talkingPoints = districts.map((d) => {
          const headline =
            jobsPerDistrict != null
              ? `${cap.name} supports ~${jobsPerDistrict.toLocaleString()} jobs in ${d.state}-${d.district}.`
              : `${cap.name} has district nexus in ${d.state}-${d.district} with labor force ${d.laborForceSize ? d.laborForceSize.toLocaleString() : 'N/A'}.`;
          return {
            district: `${d.state}-${d.district}`,
            headline,
            evidence: {
              laborForceSize: d.laborForceSize,
              unemploymentRate: d.unemploymentRate,
              topIndustries: d.topIndustries,
              dataYear: d.dataYear,
            },
          };
        });

        return {
          capabilityId: cap.id,
          capabilityName: cap.name,
          capabilitySector: cap.sector,
          districtNexus: cap.districtNexus,
          districts,
          talkingPoints,
          totalSupportedJobs: jobsPerDistrict != null ? jobsPerDistrict * districts.length : null,
        };
      }),
    };
  }
}
