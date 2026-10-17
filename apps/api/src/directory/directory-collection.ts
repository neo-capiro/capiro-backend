export function uniqueSorted<T extends string>(
  values: T[],
  compareFn?: (left: T, right: T) => number,
): T[] {
  return Array.from(new Set(values.filter(Boolean))).sort(
    compareFn ?? ((left, right) => left.localeCompare(right)),
  );
}
