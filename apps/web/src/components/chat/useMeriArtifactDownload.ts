import { useEffect, useRef, useState } from 'react';
import { fetchMeriArtifactDownload, saveMeriDownloadBlob, type MeriArtifactAuthHeaders } from './meri-artifact-download.js';

/** An artifact or auth-context change cancels the old request. A fresh click
 * always resolves current auth and fetches the same durable artifact identity. */
export function useMeriArtifactDownload({
  artifactId, apiBaseUrl, getAuthHeaders, fallbackFilename, expectedFormat,
}: {
  artifactId?: string;
  apiBaseUrl?: string;
  getAuthHeaders?: MeriArtifactAuthHeaders;
  fallbackFilename?: string;
  expectedFormat?: string;
}) {
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const active = useRef<AbortController | null>(null);

  useEffect(() => {
    setDownloading(false);
    setDownloadError(null);
    return () => {
      active.current?.abort();
      active.current = null;
    };
  }, [artifactId, apiBaseUrl, getAuthHeaders]);

  const downloadOfficeDoc = async () => {
    if (active.current) return;
    if (!artifactId) {
      setDownloadError('This document is not available for download yet — try regenerating it in chat.');
      return;
    }
    const request = new AbortController();
    active.current = request;
    setDownloading(true);
    setDownloadError(null);
    const timeout = window.setTimeout(() => request.abort(new Error('The download timed out. Please retry.')), 120_000);
    try {
      const { blob, filename } = await fetchMeriArtifactDownload({
        artifactId, apiBaseUrl: apiBaseUrl ?? '', getAuthHeaders,
        signal: request.signal, fallbackFilename, expectedFormat,
      });
      if (active.current === request) saveMeriDownloadBlob(blob, filename);
    } catch (error) {
      if (active.current === request) {
        setDownloadError(request.signal.aborted
          ? 'The download timed out. Please retry.'
          : error instanceof Error ? error.message : 'The document could not be downloaded. Please retry.');
      }
    } finally {
      window.clearTimeout(timeout);
      if (active.current === request) {
        active.current = null;
        setDownloading(false);
      }
    }
  };

  return { downloading, downloadError, downloadOfficeDoc };
}
