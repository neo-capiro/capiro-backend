import { useQuery } from '@tanstack/react-query';
import { Alert, Empty, Spin } from 'antd';
import type { AxiosInstance } from 'axios';
import { districtKmlUrl } from './directory-api.js';
import { parseKmlToSvgPaths } from './district-kml.js';

/**
 * Static shape preview for a district boundary — no basemap, no pan/zoom,
 * just the silhouette. `hasBoundary` gates whether we even attempt the
 * fetch (WS-B's --with-kml is opt-in, so most districts have none yet).
 */
export function DistrictBoundaryPreview({
  api,
  state,
  districtNo,
  status,
  hasBoundary,
}: {
  api: AxiosInstance;
  state: string;
  districtNo: string;
  status: 'C' | 'F';
  hasBoundary: boolean;
}) {
  const query = useQuery({
    queryKey: ['district-kml', state, districtNo, status],
    queryFn: async () => {
      const { data } = await api.get<string>(districtKmlUrl(state, districtNo, status), {
        responseType: 'text',
      });
      return parseKmlToSvgPaths(data);
    },
    enabled: hasBoundary,
    staleTime: 10 * 60_000,
    retry: 1,
  });

  if (!hasBoundary) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description="Boundary not yet fetched for this district"
      />
    );
  }
  if (query.isLoading) return <Spin />;
  if (query.isError || !query.data) {
    return (
      <Alert
        type="warning"
        showIcon
        message="Boundary unavailable"
        description="The stored boundary could not be loaded."
      />
    );
  }

  const { paths, viewBox } = query.data;
  return (
    <svg
      viewBox={viewBox}
      style={{ width: '100%', maxWidth: 360, height: 'auto', display: 'block' }}
      aria-label={`${state} district ${districtNo} boundary`}
    >
      {paths.map((d, i) => (
        <path
          key={i}
          d={d}
          fillRule="evenodd"
          fill="#1f3a5f"
          fillOpacity={0.25}
          stroke="#1f3a5f"
          strokeWidth={1.5}
        />
      ))}
    </svg>
  );
}
