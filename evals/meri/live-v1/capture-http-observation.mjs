import { redactSecrets, sha256Bytes } from './artifact-collector.mjs';

/** Diagnostic observations only: this never creates capture, grade or spending
 * authority. Save before interpreting HTTP, JSON, SSE, citations or saved rows.
 * No request headers, cookies or auth state are accepted into the record. */
export async function writeCaptureHttpObservation(writer, ref, response, bearer) {
  const bytes = Buffer.isBuffer(response.bytes)
    ? response.bytes
    : Buffer.from(response.text, 'utf8');
  if (bytes.length > 8 * 1024 * 1024) throw new Error('CAPTURE_OBSERVATION_LIMIT');
  let text = bytes.toString('utf8');
  const redactJson = (value) => {
    try {
      const parsed = JSON.parse(value);
      const clean = redactSecrets(parsed, [bearer]);
      return JSON.stringify(parsed) === JSON.stringify(clean) ? value : JSON.stringify(clean);
    } catch {
      return value;
    }
  };
  text = redactJson(text);
  text = text.replace(/^(data:\s*)([^\r\n]*)/gmu, (_, prefix, value) => prefix + redactJson(value));
  // Redact both structured JSON/SSE credential fields and plain credential lines.
  // Keep the original byte hash separately; redacted text is never source proof.
  text = text.replace(
    /("(?:authorization|cookie|set-cookie|password|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|session[_-]?(?:id|token)?)"\s*:\s*)"(?:\\.|[^"\\])*"/giu,
    '$1"[REDACTED]"',
  );
  text = text.replace(
    /^(?:authorization|cookie|set-cookie|password|secret|api[_-]?key|access[_-]?token|refresh[_-]?token)\s*[:=][^\r\n]*/gimu,
    '[REDACTED_CREDENTIAL_LINE]',
  );
  text = redactSecrets(text, [bearer]);
  if (typeof bearer === 'string' && bearer.length) text = text.split(bearer).join('[REDACTED]');
  const observation = {
    schemaVersion: 1,
    kind: 'meri-http-response-observation',
    captureAuthority: false,
    acceptanceStatus: 'NOT_RUN',
    status: response.status,
    releaseSha: /^[a-f0-9]{40}$/u.test(response.releaseSha ?? '') ? response.releaseSha : null,
    bodyBytes: bytes.length,
    bodySha256: sha256Bytes(bytes),
    redacted: text !== bytes.toString('utf8'),
    text,
  };
  return writer.writeBytes(ref, Buffer.from(JSON.stringify(observation, null, 2) + '\n'));
}
