import {
  CONTACT_USE_LABELS,
  ContactUse,
  ContactUseInput,
  RoleType,
  classifyContactUse,
  crmLinkBlockedReason,
  isCrmLinkBlocked,
  isExcludedFromRecommendations,
  isLobbyingEligible,
} from './contact-use.policy';

describe('contact-use policy', () => {
  describe('classifyContactUse', () => {
    it('§17 HARD RULE: a sam_gov-sourced person (even roleType "staff") is an official procurement POC and NOT lobbying-eligible', () => {
      const result = classifyContactUse({
        roleType: 'staff',
        source: 'sam_gov',
        reviewStatus: 'accepted',
      });
      expect(result).toBe('official_procurement_poc');
      expect(isLobbyingEligible(result)).toBe(false);
      expect(isExcludedFromRecommendations(result)).toBe(true);
    });

    it('FAR HARD RULE: a contracting_officer (any source) is an official procurement POC, never a lobbying contact', () => {
      for (const source of ['sam_gov', 'peo_roster', 'dod_orgchart', 'manual']) {
        const result = classifyContactUse({
          roleType: 'contracting_officer',
          source,
          reviewStatus: 'accepted',
        });
        expect(result).toBe('official_procurement_poc');
        expect(isLobbyingEligible(result)).toBe(false);
      }
    });

    it('SOURCE-SELECTION EXCLUSION: a source-selection-adjacent person is do-not-contact and excluded from recommendations', () => {
      const result = classifyContactUse({
        roleType: 'staff',
        source: 'peo_roster',
        reviewStatus: 'accepted',
        sourceSelectionAdjacent: true,
      });
      expect(result).toBe('do_not_contact_procurement_sensitive');
      expect(isExcludedFromRecommendations(result)).toBe(true);
      expect(isLobbyingEligible(result)).toBe(false);
    });

    it('quarantine short-circuits to "quarantined" and is excluded from recommendations', () => {
      const result = classifyContactUse({
        roleType: 'pm',
        source: 'peo_roster',
        reviewStatus: 'quarantined',
      });
      expect(result).toBe('quarantined');
      expect(isExcludedFromRecommendations(result)).toBe(true);
    });

    it('quarantine takes priority even over the FAR hard rule', () => {
      // A quarantined contracting_officer is still surfaced as quarantined, not as a POC.
      const result = classifyContactUse({
        roleType: 'contracting_officer',
        source: 'sam_gov',
        reviewStatus: 'quarantined',
      });
      expect(result).toBe('quarantined');
    });

    it('a candidate (non-procurement, not yet reviewed) -> "candidate" and is excluded from recommendations', () => {
      const result = classifyContactUse({
        roleType: 'pm',
        source: 'peo_roster',
        reviewStatus: 'candidate',
      });
      expect(result).toBe('candidate');
      expect(isExcludedFromRecommendations(result)).toBe(true);
    });

    it('an accepted peo_roster PM -> "program_ownership_context": NOT excluded from recommendations, but NOT lobbying-eligible either', () => {
      const result = classifyContactUse({
        roleType: 'pm',
        source: 'peo_roster',
        reviewStatus: 'accepted',
      });
      expect(result).toBe('program_ownership_context');
      // program_ownership_context is not in the exclusion set...
      expect(isExcludedFromRecommendations(result)).toBe(false);
      // ...but it is still not an invitation to lobby.
      expect(isLobbyingEligible(result)).toBe(false);
    });

    it('FAR rule beats source-selection: contracting_officer wins even when sourceSelectionAdjacent is true', () => {
      const result = classifyContactUse({
        roleType: 'contracting_officer',
        source: 'manual',
        reviewStatus: 'accepted',
        sourceSelectionAdjacent: true,
      });
      expect(result).toBe('official_procurement_poc');
    });

    it('FAR rule applies even to a candidate review status (sam_gov candidate -> official_procurement_poc, not "candidate")', () => {
      const result = classifyContactUse({
        roleType: 'staff',
        source: 'sam_gov',
        reviewStatus: 'candidate',
      });
      expect(result).toBe('official_procurement_poc');
    });

    it('NEVER auto-promotes to "lobbying_contact" for ANY combination of roleType x source x reviewStatus', () => {
      const roleTypes: Array<RoleType | string> = [
        'peo',
        'pm',
        'deputy',
        'chief_engineer',
        'contracting_officer',
        'staff',
        'other',
        'unknown_future_role',
      ];
      const sources = ['sam_gov', 'peo_roster', 'dod_orgchart', 'manual', 'unknown_source'];
      const reviewStatuses = ['accepted', 'candidate', 'quarantined', 'unknown_status'];
      const sourceSelectionFlags = [undefined, true, false];

      for (const roleType of roleTypes) {
        for (const source of sources) {
          for (const reviewStatus of reviewStatuses) {
            for (const sourceSelectionAdjacent of sourceSelectionFlags) {
              const input: ContactUseInput = {
                roleType,
                source,
                reviewStatus,
                sourceSelectionAdjacent,
              };
              const result = classifyContactUse(input);
              expect(result).not.toBe('lobbying_contact');
              expect(isLobbyingEligible(result)).toBe(false);
            }
          }
        }
      }
    });
  });

  describe('isLobbyingEligible / isExcludedFromRecommendations (table-driven)', () => {
    const cases: Array<{
      contactUse: ContactUse;
      lobbyingEligible: boolean;
      excluded: boolean;
    }> = [
      { contactUse: 'lobbying_contact', lobbyingEligible: true, excluded: false },
      { contactUse: 'program_ownership_context', lobbyingEligible: false, excluded: false },
      { contactUse: 'official_procurement_poc', lobbyingEligible: false, excluded: true },
      { contactUse: 'internal_owner', lobbyingEligible: false, excluded: false },
      { contactUse: 'relationship_owner', lobbyingEligible: false, excluded: false },
      {
        contactUse: 'do_not_contact_procurement_sensitive',
        lobbyingEligible: false,
        excluded: true,
      },
      { contactUse: 'candidate', lobbyingEligible: false, excluded: true },
      { contactUse: 'quarantined', lobbyingEligible: false, excluded: true },
    ];

    it.each(cases)(
      '%j has correct lobbying-eligibility and recommendation-exclusion',
      ({ contactUse, lobbyingEligible, excluded }) => {
        expect(isLobbyingEligible(contactUse)).toBe(lobbyingEligible);
        expect(isExcludedFromRecommendations(contactUse)).toBe(excluded);
      },
    );

    it('only "lobbying_contact" is lobbying-eligible', () => {
      const eligible = cases.filter((c) => isLobbyingEligible(c.contactUse));
      expect(eligible.map((c) => c.contactUse)).toEqual(['lobbying_contact']);
    });
  });

  describe('CONTACT_USE_LABELS', () => {
    const allContactUses: ContactUse[] = [
      'lobbying_contact',
      'program_ownership_context',
      'official_procurement_poc',
      'internal_owner',
      'relationship_owner',
      'do_not_contact_procurement_sensitive',
      'candidate',
      'quarantined',
    ];

    it('provides a non-empty human label for every ContactUse value', () => {
      for (const cu of allContactUses) {
        expect(typeof CONTACT_USE_LABELS[cu]).toBe('string');
        expect(CONTACT_USE_LABELS[cu].length).toBeGreaterThan(0);
      }
    });

    it('uses the documented labels', () => {
      expect(CONTACT_USE_LABELS.official_procurement_poc).toBe('Official procurement POC');
      expect(CONTACT_USE_LABELS.program_ownership_context).toBe('Program ownership context');
      expect(CONTACT_USE_LABELS.candidate).toBe('Candidate — requires review');
      expect(CONTACT_USE_LABELS.do_not_contact_procurement_sensitive).toBe(
        'Do not contact (procurement-sensitive)',
      );
    });
  });

  describe('isCrmLinkBlocked', () => {
    const cases: Array<{ contactUse: ContactUse; blocked: boolean }> = [
      { contactUse: 'official_procurement_poc', blocked: true },
      { contactUse: 'do_not_contact_procurement_sensitive', blocked: true },
      { contactUse: 'candidate', blocked: true },
      { contactUse: 'quarantined', blocked: true },
      { contactUse: 'program_ownership_context', blocked: false },
      { contactUse: 'lobbying_contact', blocked: false },
      { contactUse: 'internal_owner', blocked: false },
      { contactUse: 'relationship_owner', blocked: false },
    ];

    it.each(cases)('%j has expected CRM-link block', ({ contactUse, blocked }) => {
      expect(isCrmLinkBlocked(contactUse)).toBe(blocked);
      if (blocked) {
        expect(crmLinkBlockedReason(contactUse).length).toBeGreaterThan(10);
      }
    });

    it('context roles remain non-lobbying-eligible even when CRM link is allowed', () => {
      expect(isCrmLinkBlocked('program_ownership_context')).toBe(false);
      expect(isLobbyingEligible('program_ownership_context')).toBe(false);
      expect(isCrmLinkBlocked('internal_owner')).toBe(false);
      expect(isLobbyingEligible('internal_owner')).toBe(false);
    });
  });

});
