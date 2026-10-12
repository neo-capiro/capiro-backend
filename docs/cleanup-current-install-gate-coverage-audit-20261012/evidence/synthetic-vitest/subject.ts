export function classify(value: number): string {
  if (value > 0) return "positive";
  if (value < 0) return "negative";
  return "zero";
}
