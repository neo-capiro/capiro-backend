/** One scalar-safe UTF-16 section owner for HTTP and the existing Meri mapper. */
const highSurrogate = (unit: number) => unit >= 0xd800 && unit <= 0xdbff;
const lowSurrogate = (unit: number) => unit >= 0xdc00 && unit <= 0xdfff;
export const mailSurrogatePair = (value: string, at: number) => at >= 0 && at + 1 < value.length &&
  highSurrogate(value.charCodeAt(at)) && lowSurrogate(value.charCodeAt(at + 1));
export function isWellFormedMailText(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (highSurrogate(unit)) {
      if (!mailSurrogatePair(value, index)) return false;
      index++;
    } else if (lowSurrogate(unit)) return false;
  }
  return true;
}

export function createMailBodySection(text: string, offset: number, max: number) {
  if (!isWellFormedMailText(text) || !Number.isSafeInteger(offset) || offset < 0 || offset > 10000000 ||
      !Number.isSafeInteger(max) || max < 1 || max > 6000) throw new RangeError('Invalid mail body section');
  let start = Math.min(offset, text.length), end = Math.min(text.length, offset + max);
  if (start > 0 && mailSurrogatePair(text, start - 1)) start--;
  if (end > start && end < text.length && mailSurrogatePair(text, end - 1)) end--;
  if (end === start && start < text.length) end = start + (mailSurrogatePair(text, start) ? 2 : 1);
  return {bodyText: text.slice(start, end), bodyOffset: start, bodyLength: text.length,
    bodyTruncated: start > 0 || end < text.length,
    nextBodyOffset: end < text.length ? end : null};
}
