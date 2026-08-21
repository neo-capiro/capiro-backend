/**
 * Which Congress is in session on a given date (District Nexus Release 1, §12).
 *
 * A Congress's two-year term runs from January 3 of an odd-numbered year
 * through January 3 of the next odd-numbered year (U.S. Const. amend. XX,
 * §2 — the modern convention since 1935; every Congress this helper will ever
 * be asked about postdates that). The 119th Congress began January 3, 2025;
 * the 120th begins January 3, 2027.
 *
 * Deliberately not a hardcoded constant (a `CURRENT_CONGRESS = 119` sentinel
 * would silently become wrong the moment the 120th Congress is seated) and
 * deliberately not derived from `Date.now()` internally — the caller supplies
 * `date`, so this stays pure and testable around the January 3 boundary.
 */
export function currentCongressNumber(date: Date): number {
  const year = date.getUTCFullYear();
  // The nearest odd year at or below the given date's year — a Congress term
  // can only have STARTED in an odd year.
  let candidateYear = year % 2 === 0 ? year - 1 : year;
  // If the given date falls before January 3 of that candidate year, the term
  // that started there hasn't begun yet — the PRIOR Congress (two years
  // earlier) is still the one in session.
  if (date.getTime() < Date.UTC(candidateYear, 0, 3)) candidateYear -= 2;
  return (candidateYear - 1789) / 2 + 1;
}
