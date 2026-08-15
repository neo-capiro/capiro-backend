import { useEffect, useRef, useState as useStateSafe } from 'react';

/**
 * React host for the prototype's `<district-nexus-map>` web component
 * (PORTFOLIO-UI-BUILD-SPEC §13). The component's logic is transcribed verbatim
 * from the extracted bundle (district-nexus-map.js): real Natural Earth
 * geometry via d3-geo + topojson, Albers-USA projection, collision relaxation,
 * leader lines, legend + attribution, offline failure state.
 *
 * d3 and topojson are loaded once from the pinned CDN tags (§13). Geometry
 * (countries-110m) is fetched once and cached at module scope.
 */

const D3_URL = 'https://unpkg.com/d3@7.9.0/dist/d3.min.js';
const D3_INTEGRITY = 'sha384-CjloA8y00+1SDAUkjs099PVfnY2KmDC2BZnws9kh8D/lX1s46w6EPhpXdqMfjK6i';
const TOPO_URL = 'https://unpkg.com/topojson-client@3.1.0/dist/topojson-client.min.js';
const TOPO_INTEGRITY = 'sha384-Ukv1p/xTma6P4/2bY5KzWBw+ydSpXmhCMtyciIQVDJ1RmOxtCYNMF1uXT9T63H67';
const ATLAS_URL = 'https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/countries-110m.json';

declare global {
  interface Window {
    d3?: any;
    topojson?: any;
    __districtNexusMapDefined?: boolean;
  }
}

let libsPromise: Promise<void> | null = null;
let usaPromise: Promise<any> | null = null;

function loadScript(src: string, integrity: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`) as HTMLScriptElement | null;
    if (existing) {
      if (existing.dataset.loaded === '1') return resolve();
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', () => reject(new Error(`load ${src}`)));
      return;
    }
    const s = document.createElement('script');
    s.src = src;
    s.integrity = integrity;
    s.crossOrigin = 'anonymous';
    s.addEventListener('load', () => {
      s.dataset.loaded = '1';
      resolve();
    });
    s.addEventListener('error', () => reject(new Error(`load ${src}`)));
    document.head.appendChild(s);
  });
}

function libs(): Promise<void> {
  if (window.d3 && window.topojson) return Promise.resolve();
  if (!libsPromise) {
    libsPromise = (async () => {
      await loadScript(D3_URL, D3_INTEGRITY);
      await loadScript(TOPO_URL, TOPO_INTEGRITY);
      if (!window.d3 || !window.topojson) throw new Error('d3/topojson unavailable');
    })();
    // Allow retry on a later mount if the first load failed.
    libsPromise.catch(() => {
      libsPromise = null;
    });
  }
  return libsPromise;
}

function usa(): Promise<any> {
  if (!usaPromise) {
    usaPromise = libs()
      .then(() => fetch(ATLAS_URL))
      .then((r) => {
        if (!r.ok) throw new Error(`atlas ${r.status}`);
        return r.json();
      })
      .then((topo) => {
        const fc = window.topojson.feature(topo, topo.objects.countries);
        const f = fc.features.find((x: any) => String(x.id) === '840' || /united states/i.test(x.properties?.name));
        if (!f) throw new Error('US geometry missing');
        return f;
      });
    usaPromise.catch(() => {
      usaPromise = null;
    });
  }
  return usaPromise;
}

export interface DistrictPoint {
  code: string;
  score: number;
  lat: number;
  lon: number;
  la?: string;
  lv?: number;
}

export function DistrictNexusMap({
  districts,
  selected,
  onSelect,
}: {
  districts: DistrictPoint[];
  selected: string;
  onSelect: (code: string) => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const usaRef = useRef<any>(null);
  const [failed, setFailed] = useStateSafe(false);

  // Load geometry once.
  useEffect(() => {
    let cancelled = false;
    usa()
      .then((f) => {
        if (!cancelled) {
          usaRef.current = f;
          draw();
        }
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Redraw on selection / data / size.
  useEffect(() => {
    draw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, JSON.stringify(districts)]);

  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(() => draw());
    ro.observe(ref.current);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function draw() {
    const el = ref.current;
    const d3 = window.d3;
    if (!el || !usaRef.current || !d3) return;
    const w = Math.max(el.clientWidth || 0, 320);
    const h = Math.max(el.clientHeight || 0, 260);
    const proj = d3.geoAlbersUsa().fitExtent([[26, 26], [w - 26, h - 34]], usaRef.current);
    const path = d3.geoPath(proj);

    el.innerHTML = '';
    const NS = 'http://www.w3.org/2000/svg';
    const mk = (n: string, a: Record<string, string | number>) => {
      const x = document.createElementNS(NS, n);
      for (const k in a) x.setAttribute(k, String(a[k]));
      return x;
    };
    const svg = mk('svg', { width: w, height: h, viewBox: `0 0 ${w} ${h}`, role: 'img', 'aria-label': 'Congressional district nexus map' });
    (svg as any).setAttribute('style', 'display:block;border-radius:10px;background:#FCFCFD');

    const defs = mk('defs', {});
    const grad = mk('radialGradient', { id: 'dnm-glow' });
    grad.appendChild(mk('stop', { offset: '0%', 'stop-color': '#101828', 'stop-opacity': '.16' }));
    grad.appendChild(mk('stop', { offset: '100%', 'stop-color': '#101828', 'stop-opacity': '0' }));
    defs.appendChild(grad);
    svg.appendChild(defs);

    if (d3.geoGraticule10) {
      svg.appendChild(mk('path', { d: path(d3.geoGraticule10()), fill: 'none', stroke: '#F2F4F7', 'stroke-width': 1 }));
    }
    svg.appendChild(mk('path', { d: path(usaRef.current), fill: '#F2F4F7', stroke: '#D0D5DD', 'stroke-width': 1, 'stroke-linejoin': 'round' }));

    const rad = w < 820 ? (s: number) => 4 + (s / 100) * 5 : (s: number) => 5 + (s / 100) * 7;
    const pts = districts
      .map((r) => {
        const p = proj([r.lon, r.lat]);
        return p ? { ...r, x: p[0], y: p[1], tx: p[0], ty: p[1], r: rad(r.score), off: false } : null;
      })
      .filter(Boolean)
      .sort((a: any, b: any) => a.score - b.score) as any[];

    for (let pass = 0; pass < 60; pass++) {
      let moved = false;
      for (let i = 0; i < pts.length; i++) {
        for (let j = i + 1; j < pts.length; j++) {
          const a = pts[i];
          const b = pts[j];
          const need = a.r + b.r + 16;
          let dx = b.x - a.x;
          let dy = b.y - a.y;
          let d = Math.sqrt(dx * dx + dy * dy);
          if (d >= need) continue;
          if (d < 0.01) {
            dx = 1;
            dy = 0;
            d = 1;
          }
          const push = (need - d) / 2;
          const ux = (dx / d) * push;
          const uy = (dy / d) * push;
          a.x -= ux;
          a.y -= uy;
          b.x += ux;
          b.y += uy;
          moved = true;
        }
      }
      if (!moved) break;
    }
    pts.forEach((p) => {
      p.x = Math.max(14, Math.min(w - 14, p.x));
      p.y = Math.max(14, Math.min(h - 24, p.y));
      p.off = Math.hypot(p.x - p.tx, p.y - p.ty) > 2.5;
    });

    pts.filter((p) => p.off).forEach((p) => {
      svg.appendChild(mk('line', { x1: p.tx, y1: p.ty, x2: p.x, y2: p.y, stroke: '#98A2B3', 'stroke-width': 1, 'stroke-dasharray': '2 2', opacity: '.7' }));
      svg.appendChild(mk('circle', { cx: p.tx, cy: p.ty, r: 1.8, fill: '#98A2B3' }));
    });

    pts.forEach((p) => {
      const on = p.code === selected;
      const r = p.r;
      if (on) svg.appendChild(mk('circle', { cx: p.x, cy: p.y, r: r + 26, fill: 'url(#dnm-glow)' }));
      svg.appendChild(mk('circle', { cx: p.x, cy: p.y, r: r + 6, fill: 'none', stroke: on ? '#101828' : '#98A2B3', 'stroke-width': on ? 2 : 1, opacity: on ? 1 : '.45' }));
      const dot = mk('circle', {
        cx: p.x,
        cy: p.y,
        r,
        fill: p.score >= 80 ? '#101828' : p.score >= 60 ? '#475467' : '#98A2B3',
        stroke: '#ffffff',
        'stroke-width': 1.5,
        cursor: 'pointer',
      });
      dot.addEventListener('click', () => onSelect(p.code));
      svg.appendChild(dot);

      const lx = p.x + (p.la === 'l' ? -(r + 12) : r + 12);
      const ly = p.y + (p.lv || 0);
      const anchor = p.la === 'l' ? 'end' : 'start';
      const code = mk('text', { x: lx, y: ly - 1, 'text-anchor': anchor });
      code.setAttribute('style', `font:600 12px Inter,ui-sans-serif,system-ui,sans-serif;fill:${on ? '#101828' : '#344054'};letter-spacing:.02em;paint-order:stroke;stroke:#FCFCFD;stroke-width:3px`);
      code.textContent = p.code;
      svg.appendChild(code);
      const meta = mk('text', { x: lx, y: ly + 13, 'text-anchor': anchor });
      meta.setAttribute('style', 'font:500 11px Inter,ui-sans-serif,system-ui,sans-serif;fill:#667085;paint-order:stroke;stroke:#FCFCFD;stroke-width:3px');
      meta.textContent = `Nexus ${p.score}`;
      svg.appendChild(meta);
    });

    el.appendChild(svg);

    const legend = document.createElement('div');
    legend.style.cssText =
      'position:absolute;left:14px;bottom:12px;display:flex;align-items:center;gap:14px;padding:7px 11px;border-radius:8px;background:rgba(255,255,255,.92);box-shadow:inset 0 0 0 1px #EAECF0;font:600 11px Inter,ui-sans-serif,system-ui,sans-serif;color:#667085;letter-spacing:.04em;text-transform:uppercase';
    ([['#101828', 'Strong'], ['#475467', 'Moderate'], ['#98A2B3', 'Developing']] as const).forEach(([c, l]) => {
      const s = document.createElement('span');
      s.style.cssText = 'display:inline-flex;align-items:center;gap:6px';
      s.innerHTML = `<span style="width:8px;height:8px;border-radius:50%;background:${c}"></span>${l}`;
      legend.appendChild(s);
    });
    el.appendChild(legend);

    const src = document.createElement('div');
    src.style.cssText = 'position:absolute;right:14px;bottom:12px;font:500 11px Inter,ui-sans-serif,system-ui,sans-serif;color:#98A2B3';
    src.textContent = 'Natural Earth · Albers USA';
    el.appendChild(src);
  }

  if (failed) {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100%',
          minHeight: 240,
          padding: 24,
          textAlign: 'center',
          fontSize: 13,
          fontWeight: 500,
          lineHeight: '19px',
          color: '#667085',
          background: '#F9FAFB',
          borderRadius: 10,
          boxShadow: 'inset 0 0 0 1px #EAECF0',
        }}
      >
        Map geometry unavailable offline. District list remains available.
      </div>
    );
  }

  return <div ref={ref} style={{ position: 'relative', width: '100%', height: '100%', display: 'block' }} />;
}
