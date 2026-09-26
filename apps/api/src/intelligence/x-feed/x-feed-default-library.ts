export interface XFeedDefaultAccount {
  key: string;
  displayName: string;
  username: string;
  category: string;
  rationale: string;
}

/** Curated starter accounts shown in the dashboard's default library. */
export const DEFAULT_X_FEED_ACCOUNTS: readonly XFeedDefaultAccount[] = [
  { key: 'realDonaldTrump', displayName: 'Donald Trump', username: 'realDonaldTrump', category: 'Executive', rationale: 'Presidential policy direction, budget priorities, national security, trade, nominations' },
  { key: 'WhiteHouse', displayName: 'White House', username: 'WhiteHouse', category: 'Executive', rationale: 'Formal administration announcements and executive actions' },
  { key: 'POTUS', displayName: 'President of the United States', username: 'POTUS', category: 'Executive', rationale: 'Official presidential communications' },
  { key: 'VP', displayName: 'Vice President', username: 'VP', category: 'Executive', rationale: 'Administration priorities and congressional engagement' },
  { key: 'SecWar', displayName: 'Pete Hegseth', username: 'SecWar', category: 'Defense', rationale: 'Defense policy, force structure, acquisition and strategic priorities' },
  { key: 'DeptofWar', displayName: 'Department of War', username: 'DeptofWar', category: 'Defense', rationale: 'Department-wide defense announcements, operations, contracts and policy' },
  { key: 'SecRubio', displayName: 'Marco Rubio', username: 'SecRubio', category: 'Executive', rationale: 'Foreign policy, sanctions, security assistance and international developments' },
  { key: 'StateDept', displayName: 'Department of State', username: 'StateDept', category: 'Defense', rationale: 'Diplomatic and foreign-policy actions' },
  { key: 'russvought', displayName: 'Russ Vought', username: 'russvought', category: 'Budget', rationale: 'OMB, federal spending, budget execution and administration fiscal policy' },
  { key: 'SecArmy', displayName: 'Secretary of the Army', username: 'SecArmy', category: 'Defense', rationale: 'Army modernization, acquisition, UAS, munitions and programs' },
  { key: 'SecAFOfficial', displayName: 'Secretary of the Air Force', username: 'SecAFOfficial', category: 'Defense', rationale: 'Air Force and Space Force budgets, programs and modernization' },
  { key: 'SECNAV', displayName: 'Secretary of the Navy', username: 'SECNAV', category: 'Defense', rationale: 'Navy, Marine Corps, shipbuilding and maritime modernization' },
  { key: 'USArmy', displayName: 'U.S. Army', username: 'USArmy', category: 'Defense', rationale: 'Army programs, capabilities and operational activity' },
  { key: 'USNavy', displayName: 'U.S. Navy', username: 'USNavy', category: 'Defense', rationale: 'Naval programs, operations and acquisition' },
  { key: 'usairforce', displayName: 'U.S. Air Force', username: 'usairforce', category: 'Defense', rationale: 'Air Force programs and modernization' },
  { key: 'SpaceForceDoD', displayName: 'U.S. Space Force', username: 'SpaceForceDoD', category: 'Defense', rationale: 'Space acquisition, programs, architecture and policy' },
  { key: 'SpeakerJohnson', displayName: 'Speaker Mike Johnson', username: 'SpeakerJohnson', category: 'Congressional leadership', rationale: 'House agenda, floor strategy, appropriations and major negotiations' },
  { key: 'LeaderJohnThune', displayName: 'Senate Majority Leader John Thune', username: 'LeaderJohnThune', category: 'Congressional leadership', rationale: 'Senate agenda, floor timing, nominations and legislation' },
  { key: 'SenJohnBarrasso', displayName: 'Senate Majority Whip John Barrasso', username: 'SenJohnBarrasso', category: 'Congressional leadership', rationale: 'Vote counting, leadership priorities and legislative viability' },
  { key: 'RepJeffries', displayName: 'House Democratic Leader Hakeem Jeffries', username: 'RepJeffries', category: 'Congressional leadership', rationale: 'House minority strategy and negotiations' },
  { key: 'SenSchumer', displayName: 'Senate Democratic Leader Chuck Schumer', username: 'SenSchumer', category: 'Congressional leadership', rationale: 'Senate minority strategy and negotiations' },
  { key: 'SenatorWicker', displayName: 'Sen. Roger Wicker', username: 'SenatorWicker', category: 'Congressional leadership', rationale: 'SASC chairman, NDAA and defense policy' },
  { key: 'RepMikeRogersAL', displayName: 'Rep. Mike Rogers', username: 'RepMikeRogersAL', category: 'Congressional leadership', rationale: 'HASC chairman, House NDAA and defense authorization' },
  { key: 'SenatorCollins', displayName: 'Sen. Susan Collins', username: 'SenatorCollins', category: 'Congressional leadership', rationale: 'Senate Appropriations chair and major funding decisions' },
  { key: 'HouseAppropsGOP', displayName: 'House Appropriations Republicans', username: 'HouseAppropsGOP', category: 'Appropriations', rationale: 'Appropriations bills, markups, amendments, report language and funding negotiations' },
  { key: 'AppropsDems', displayName: 'House Appropriations Democrats', username: 'AppropsDems', category: 'Appropriations', rationale: 'Appropriations bills, markups, amendments and funding negotiations' },
  { key: 'AppropsGOP', displayName: 'Senate Appropriations Republicans', username: 'AppropsGOP', category: 'Appropriations', rationale: 'Senate appropriations and funding negotiations' },
  { key: 'SenateApprops', displayName: 'Senate Appropriations Democrats', username: 'SenateApprops', category: 'Appropriations', rationale: 'Senate appropriations and funding negotiations' },
  { key: 'AppropsAmendmts', displayName: 'House Appropriations Amendments', username: 'AppropsAmendmts', category: 'Appropriations', rationale: 'Appropriations amendments, markups and report language' },
  { key: 'HASCRepublicans', displayName: 'House Armed Services Republicans', username: 'HASCRepublicans', category: 'Armed Services', rationale: 'House NDAA and defense authorization' },
  { key: 'HASCDemocrats', displayName: 'House Armed Services Democrats', username: 'HASCDemocrats', category: 'Armed Services', rationale: 'House NDAA and defense authorization' },
  { key: 'SASCGOP', displayName: 'Senate Armed Services Republicans', username: 'SASCGOP', category: 'Armed Services', rationale: 'Senate NDAA and defense authorization' },
  { key: 'SASCDems', displayName: 'Senate Armed Services Democrats', username: 'SASCDems', category: 'Armed Services', rationale: 'Senate NDAA and defense authorization' },
  { key: 'HouseBudgetGOP', displayName: 'House Budget Republicans', username: 'HouseBudgetGOP', category: 'Budget', rationale: 'Toplines, reconciliation, deficit policy and budget resolutions' },
  { key: 'HouseBudgetDems', displayName: 'House Budget Democrats', username: 'HouseBudgetDems', category: 'Budget', rationale: 'Toplines, reconciliation, deficit policy and budget resolutions' },
  { key: 'BudgetGOP', displayName: 'Senate Budget Republicans', username: 'BudgetGOP', category: 'Budget', rationale: 'Toplines, reconciliation, deficit policy and budget resolutions' },
  { key: 'SenateBudget', displayName: 'Senate Budget Democrats', username: 'SenateBudget', category: 'Budget', rationale: 'Toplines, reconciliation, deficit policy and budget resolutions' },
  { key: 'RulesReps', displayName: 'House Rules Committee', username: 'RulesReps', category: 'Floor and procedure', rationale: 'Legislation and amendments being cleared for the floor' },
  { key: 'RepCloakroom', displayName: 'Republican Cloakroom', username: 'RepCloakroom', category: 'Floor and procedure', rationale: 'Live House voting and floor timing' },
  { key: 'HouseFloor', displayName: 'U.S. House Updates', username: 'HouseFloor', category: 'Floor and procedure', rationale: 'House chamber activity' },
  { key: 'SenateFloor', displayName: 'U.S. Senate Updates', username: 'SenateFloor', category: 'Floor and procedure', rationale: 'Senate floor activity' },
  { key: 'SenatePress', displayName: 'Senate Press Gallery', username: 'SenatePress', category: 'Floor and procedure', rationale: 'Senate schedule, votes and procedural updates' },
  { key: 'SenateCloakroom', displayName: 'Senate Republican Cloakroom', username: 'SenateCloakroom', category: 'Floor and procedure', rationale: 'Senate voting and floor scheduling' },
  { key: 'HouseGOP', displayName: 'House Republicans', username: 'HouseGOP', category: 'Institutional', rationale: 'Party-level priorities and messaging shifts' },
  { key: 'HouseDemocrats', displayName: 'House Democrats', username: 'HouseDemocrats', category: 'Institutional', rationale: 'Party-level priorities and messaging shifts' },
  { key: 'SenateGOP', displayName: 'Senate Republicans', username: 'SenateGOP', category: 'Institutional', rationale: 'Party-level priorities and messaging shifts' },
  { key: 'SenateDems', displayName: 'Senate Democrats', username: 'SenateDems', category: 'Institutional', rationale: 'Party-level priorities and messaging shifts' },
  { key: 'DIU_x', displayName: 'Defense Innovation Unit', username: 'DIU_x', category: 'Defense innovation', rationale: 'Defense innovation and acquisition' },
  { key: 'DARPA', displayName: 'DARPA', username: 'DARPA', category: 'Defense innovation', rationale: 'Advanced defense research and programs' },
  { key: 'USSOCOM', displayName: 'SOCOM', username: 'USSOCOM', category: 'Defense innovation', rationale: 'Special operations and national security' },
  { key: 'SOFWERX', displayName: 'SOFWERX', username: 'SOFWERX', category: 'Defense innovation', rationale: 'Special operations innovation' },
  { key: 'armyfutures', displayName: 'Army Futures Command', username: 'armyfutures', category: 'Defense innovation', rationale: 'Army modernization and future capabilities' },
  { key: 'AFResearchLab', displayName: 'Air Force Research Laboratory', username: 'AFResearchLab', category: 'Defense innovation', rationale: 'Air Force research and technology' },
  { key: 'USSF_SSC', displayName: 'Space Systems Command', username: 'USSF_SSC', category: 'Defense innovation', rationale: 'Space acquisition and architecture' },
  { key: 'NAVSEA', displayName: 'Naval Sea Systems Command', username: 'NAVSEA', category: 'Defense innovation', rationale: 'Naval acquisition and ship systems' },
  { key: 'NAVAIRNews', displayName: 'Naval Air Systems Command', username: 'NAVAIRNews', category: 'Defense innovation', rationale: 'Naval aviation acquisition and programs' },
  { key: 'USMC', displayName: 'Marine Corps', username: 'USMC', category: 'Defense innovation', rationale: 'Marine Corps programs and operations' },
  { key: 'NSAGov', displayName: 'National Security Agency', username: 'NSAGov', category: 'National security', rationale: 'National security and cyber developments' },
  { key: 'CISAgov', displayName: 'Cybersecurity and Infrastructure Security Agency', username: 'CISAgov', category: 'National security', rationale: 'Cybersecurity and critical infrastructure policy' },
];

export const DEFAULT_X_FEED_ACCOUNT_CATEGORIES = [...new Set(DEFAULT_X_FEED_ACCOUNTS.map((account) => account.category))];

export const DEFAULT_X_FEED_ACCOUNT_COUNT = DEFAULT_X_FEED_ACCOUNTS.length;

export const DEFAULT_X_FEED_ACCOUNT_HANDLES = DEFAULT_X_FEED_ACCOUNTS.map((account) => `@${account.username}`);

export const DEFAULT_X_FEED_ACCOUNT_KEYS = DEFAULT_X_FEED_ACCOUNTS.map((account) => account.key);

export const DEFAULT_X_FEED_ACCOUNT_NAMES = DEFAULT_X_FEED_ACCOUNTS.map((account) => account.displayName);

export const DEFAULT_X_FEED_ACCOUNT_RATIONALES = DEFAULT_X_FEED_ACCOUNTS.map((account) => account.rationale);

export const DEFAULT_X_FEED_ACCOUNT_CATEGORY_LABEL = 'Curated defaults';

export const DEFAULT_X_FEED_MANUAL_CATEGORY_LABEL = 'Manual accounts';

export const DEFAULT_X_FEED_ACCOUNT_LIBRARY_VERSION = 1;
export const DEFAULT_X_FEED_ACCOUNT_LIBRARY_TITLE = 'Default X accounts';
export const DEFAULT_X_FEED_ACCOUNT_LIBRARY_DESCRIPTION = `${DEFAULT_X_FEED_ACCOUNT_COUNT} curated accounts across ${DEFAULT_X_FEED_ACCOUNT_CATEGORIES.length} monitoring categories.`;
