import { resolveCommittee, type CommitteeCandidate } from '@capiro/shared';
import type { EvalCase } from '../types';

/**
 * Phase 1 M4.1/M4-A — `get_committee_roster` MECHANISM gate. Deterministic,
 * DB-free — exercises the SAME `resolveCommittee` crosswalk both
 * `ChokepointService` and the `get_committee_roster` Meri tool call, so this
 * pins "returns the DB chair, not a guess" at the CI gate: a committee name
 * that matches zero or MORE THAN ONE current committee must resolve to
 * `null` (an honest "committee referral unmatched"), never an arbitrary pick.
 */

const HASC: CommitteeCandidate = {
  systemCode: 'hsas00',
  name: 'Committee on Armed Services',
  chamber: 'house',
  parentSystemCode: null,
};
const SASC: CommitteeCandidate = {
  systemCode: 'ssas00',
  name: 'Committee on Armed Services',
  chamber: 'senate',
  parentSystemCode: null,
};

export const committeeRosterCase: EvalCase = {
  id: 'legislation.committee-roster.never-guess',
  category: 'legislation',
  description:
    'A committee name matching exactly one current committee resolves definitively; the SAME name matching two (house + senate, no chamber hint) resolves to null, never an arbitrary pick',
  async run() {
    const problems: string[] = [];
    const seed = process.env.MERIV2_EVAL_SEED_FAILURE === '1';

    // Unambiguous: an exact systemCode always resolves, regardless of the
    // (irrelevant) free-text name alongside it.
    const byCode = resolveCommittee(
      { committeeName: 'anything', committeeCode: 'hsas00', chamber: null },
      [HASC, SASC],
    );
    if (byCode?.systemCode !== 'hsas00') {
      problems.push(
        `exact systemCode lookup did not resolve to hsas00 (got ${byCode?.systemCode})`,
      );
    }

    // THE mechanism this case exists to pin: "Armed Services" names BOTH a
    // House and a Senate committee. With no chamber hint, that is genuinely
    // ambiguous — the resolver must say so, not silently pick one chamber.
    // Seed shrinks the candidate pool to one entry, which makes the SAME
    // lookup genuinely unambiguous — the unconditional assertion below then
    // (correctly) flags the non-null result, proving the gate can go red.
    const ambiguous = resolveCommittee(
      { committeeName: 'Committee on Armed Services', committeeCode: null, chamber: null },
      seed ? [HASC] : [HASC, SASC],
    );
    if (ambiguous !== null) {
      problems.push(
        `an ambiguous committee name (house + senate, no chamber hint) resolved to ${ambiguous.systemCode} instead of null — the exact "guessed a chair" failure mode`,
      );
    }

    // The SAME name, WITH a chamber hint, is no longer ambiguous.
    const disambiguated = resolveCommittee(
      { committeeName: 'Committee on Armed Services', committeeCode: null, chamber: 'senate' },
      [HASC, SASC],
    );
    if (disambiguated?.systemCode !== 'ssas00') {
      problems.push(
        `chamber-qualified lookup did not disambiguate to ssas00 (got ${disambiguated?.systemCode})`,
      );
    }

    // A name matching NOTHING in the current pool is likewise null, never a
    // fuzzy nearest-match guess.
    const noMatch = resolveCommittee(
      { committeeName: 'Committee on Interstellar Affairs', committeeCode: null, chamber: null },
      [HASC, SASC],
    );
    if (noMatch !== null) {
      problems.push(
        `a committee matching nothing resolved to ${noMatch.systemCode}, expected null`,
      );
    }

    // Parent-qualified SUBCOMMITTEE resolution. Subcommittee rows are stored
    // under a BARE short name ("Defense") with a parentSystemCode, so a
    // parent-qualified referral ("Appropriations Subcommittee on Defense") must
    // resolve via parent + chamber — and stay null when the chamber is missing
    // (HAC-D vs SAC-D is genuinely ambiguous), same anti-guessing rule.
    const HAP: CommitteeCandidate = {
      systemCode: 'hsap00',
      name: 'Committee on Appropriations',
      chamber: 'house',
      parentSystemCode: null,
    };
    const SAP: CommitteeCandidate = {
      systemCode: 'ssap00',
      name: 'Committee on Appropriations',
      chamber: 'senate',
      parentSystemCode: null,
    };
    const HACD: CommitteeCandidate = {
      systemCode: 'hsap02',
      name: 'Defense',
      chamber: 'house',
      parentSystemCode: 'hsap00',
    };
    const SACD: CommitteeCandidate = {
      systemCode: 'ssap02',
      name: 'Defense',
      chamber: 'senate',
      parentSystemCode: 'ssap00',
    };
    const subPool = [HAP, SAP, HACD, SACD];

    const sacdQualified = resolveCommittee(
      {
        committeeName: 'Appropriations Subcommittee on Defense',
        committeeCode: null,
        chamber: 'senate',
      },
      subPool,
    );
    if (sacdQualified?.systemCode !== 'ssap02') {
      problems.push(
        `parent-qualified "Appropriations Subcommittee on Defense" + senate did not resolve to ssap02 (got ${sacdQualified?.systemCode})`,
      );
    }

    const sacdFromString = resolveCommittee(
      {
        committeeName: 'Senate Appropriations Subcommittee on Defense',
        committeeCode: null,
        chamber: null,
      },
      subPool,
    );
    if (sacdFromString?.systemCode !== 'ssap02') {
      problems.push(
        `"Senate Appropriations Subcommittee on Defense" (chamber in the string) did not resolve to ssap02 (got ${sacdFromString?.systemCode})`,
      );
    }

    const ambiguousSub = resolveCommittee(
      {
        committeeName: 'Appropriations Subcommittee on Defense',
        committeeCode: null,
        chamber: null,
      },
      subPool,
    );
    if (ambiguousSub !== null) {
      problems.push(
        `ambiguous subcommittee (house + senate Defense, no chamber hint) resolved to ${ambiguousSub.systemCode} instead of null`,
      );
    }

    const bareDefense = resolveCommittee(
      { committeeName: 'Defense', committeeCode: null, chamber: 'house' },
      subPool,
    );
    if (bareDefense?.systemCode !== 'hsap02') {
      problems.push(
        `bare "Defense" + house chamber did not resolve to the House Defense subcommittee hsap02 (got ${bareDefense?.systemCode})`,
      );
    }

    return {
      pass: problems.length === 0,
      detail:
        problems.length === 0
          ? 'committee-roster mechanism sound: exact code resolves, ambiguous name (no chamber hint) returns null, chamber hint disambiguates, unknown name returns null'
          : `committee-roster FAILURES: ${problems.join('; ')}`,
    };
  },
};
