/** Public source requests stay within their qualified publisher, including redirects. */
export async function fetchPublisherBytes(
  url: string,
  hosts: readonly string[],
  maxBytes = 5_000_000,
) {
  const signal = AbortSignal.timeout(30000);
  let current = new URL(url);
  for (let redirects = 0; redirects <= 4; redirects++) {
    if (
      current.protocol !== 'https:' ||
      !hosts.includes(current.hostname) ||
      current.username ||
      current.password ||
      current.port
    )
      throw Error('PUBLISHER_URL_NOT_QUALIFIED');
    const response = await fetch(current, {
      redirect: 'manual',
      signal,
      headers: { 'User-Agent': 'Capiro-Ingestion-Bot/1.0 (+https://capiro.ai)' },
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get('location');
      if (!location) throw Error('PUBLISHER_REDIRECT_WITHOUT_LOCATION');
      current = new URL(location, current);
      continue;
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw Error(`PUBLISHER_HTTP_${response.status}`);
    }
    if (Number(response.headers.get('content-length') ?? 0) > maxBytes) {
      await response.body.cancel();
      throw Error('PUBLISHER_SIZE_LIMIT');
    }
    const reader = response.body.getReader(),
      chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.length;
        if (size > maxBytes) throw Error('PUBLISHER_SIZE_LIMIT');
        chunks.push(next.value);
      }
    } catch (e) {
      await reader.cancel();
      throw e;
    } finally {
      reader.releaseLock();
    }
    return {
      url: current.href,
      bytes: Buffer.concat(chunks),
      contentType: response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '',
    };
  }
  throw Error('PUBLISHER_REDIRECT_LIMIT');
}
