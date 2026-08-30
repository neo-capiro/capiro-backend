/**
 * Remove code points that XML 1.0 cannot represent while preserving valid
 * Unicode, including supplementary-plane characters encoded as surrogate
 * pairs. Unpaired surrogates become the replacement character so nearby text
 * is not silently joined together.
 */
export function ooxmlSafeText(value: string): string {
  let safe = "";
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (
      codeUnit === 0x09 ||
      codeUnit === 0x0a ||
      codeUnit === 0x0d ||
      (codeUnit >= 0x20 && codeUnit <= 0xd7ff) ||
      (codeUnit >= 0xe000 && codeUnit <= 0xfffd)
    ) {
      safe += value.charAt(index);
      continue;
    }

    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        safe += value.charAt(index) + value.charAt(index + 1);
        index += 1;
      } else {
        safe += "\ufffd";
      }
      continue;
    }

    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      safe += "\ufffd";
      continue;
    }

    // Other disallowed XML controls are separated rather than concatenated.
    safe += " ";
  }
  return safe;
}

/** Deeply sanitize the plain-data report snapshot before hashing/rendering. */
export function ooxmlSafeValue<T>(value: T): T {
  if (typeof value === "string") return ooxmlSafeText(value) as T;
  if (Array.isArray(value)) {
    return value.map((entry) => ooxmlSafeValue(entry)) as T;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, ooxmlSafeValue(entry)]),
    ) as T;
  }
  return value;
}
