/** Internal managed-asset URL syntax. Receiving is not ownership or fetch authority. */
import { refuse, type Json as NewsletterJson } from './json-receiving.js';

export const newsletterAssetUrl = (value: NewsletterJson, path: string) => {
  if (typeof value !== 'string' || !/^https?:\/\/[^/]/i.test(value) || /[\s\\]/.test(value))
    refuse(path);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    refuse(path);
  }
  // The configured public base may include a port/path. Do not hardcode its origin,
  // infer ownership from its token, or turn receiving into permission to fetch it.
  const suffix = /\/workspace-api\/newsletters\/assets\/file\/[a-f0-9]{64}$/;
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !suffix.test(value) ||
    !suffix.test(url.pathname)
  )
    refuse(path);
};
