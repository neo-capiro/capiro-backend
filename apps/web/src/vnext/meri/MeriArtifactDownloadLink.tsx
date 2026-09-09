import type { ReactNode } from 'react';
import { meriArtifactIdFromDownloadUrl, type MeriArtifactAuthHeaders } from '../../components/chat/meri-artifact-download.js';
import { useMeriArtifactDownload } from '../../components/chat/useMeriArtifactDownload.js';

export function MeriArtifactDownloadLink({ href, children, apiBaseUrl, getAuthHeaders }: {
  href?: string;
  children: ReactNode;
  apiBaseUrl: string;
  getAuthHeaders?: MeriArtifactAuthHeaders;
}) {
  const artifactId = meriArtifactIdFromDownloadUrl(href, apiBaseUrl);
  const { downloading, downloadError, downloadOfficeDoc } = useMeriArtifactDownload({
    artifactId: artifactId ?? undefined, apiBaseUrl, getAuthHeaders,
  });
  if (!artifactId) return <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
  return (
    <span>
      <button
        type="button"
        disabled={downloading}
        aria-busy={downloading}
        onClick={() => void downloadOfficeDoc()}
        style={{ border: 0, padding: 0, background: 'transparent', color: 'inherit', font: 'inherit', textDecoration: 'underline', cursor: downloading ? 'wait' : 'pointer' }}
      >
        {children}{downloading ? ' — downloading…' : ''}
      </button>
      {downloadError ? <span role="alert" style={{ display: 'block', color: '#B42318', fontSize: '0.9em' }}>{downloadError}</span> : null}
    </span>
  );
}
