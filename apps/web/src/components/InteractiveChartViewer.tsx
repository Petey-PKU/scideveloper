import { useEffect, useRef, useState } from 'react';
import { Download, RotateCcw } from 'lucide-react';
import { ErrorNote, Loading, Pill } from './ui';

export interface PlotlyChartPayload {
  title?: string;
  description?: string;
  data: Array<Record<string, unknown>>;
  layout?: Record<string, unknown>;
  config?: Record<string, unknown>;
}

interface PlotlyModule {
  newPlot: (el: HTMLElement, data: unknown[], layout: Record<string, unknown>, config: Record<string, unknown>) => Promise<unknown>;
  purge: (el: HTMLElement) => void;
  Plots?: { resize: (el: HTMLElement) => void };
  downloadImage?: (el: HTMLElement, opts: Record<string, unknown>) => Promise<string>;
}

export default function InteractiveChartViewer({
  payload,
  dark,
}: {
  payload: PlotlyChartPayload;
  dark?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const plotlyRef = useRef<PlotlyModule | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [logY, setLogY] = useState(false);

  useEffect(() => {
    let active = true;
    let resizeObserver: ResizeObserver | undefined;

    async function renderPlot() {
      const el = containerRef.current;
      if (!el) return;
      setLoading(true);
      setError('');
      try {
        if (!plotlyRef.current) {
          const mod = await import('plotly.js-cartesian-dist-min');
          plotlyRef.current = (mod.default ?? mod) as unknown as PlotlyModule;
        }
        if (!active || !containerRef.current) return;
        const Plotly = plotlyRef.current;
        const isDark = dark ?? document.documentElement.classList.contains('dark');
        const fg = isDark ? '#e6eef2' : '#1b262c';
        const grid = isDark ? 'rgba(255,255,255,0.09)' : 'rgba(15,23,42,0.09)';
        const bg = isDark ? '#11191f' : '#ffffff';

        const baseLayout = payload.layout ?? {};
        const mergedLayout: Record<string, unknown> = {
          paper_bgcolor: bg,
          plot_bgcolor: bg,
          font: { family: 'Inter, system-ui, sans-serif', size: 12, color: fg },
          hovermode: 'closest',
          autosize: true,
          margin: { l: 58, r: 24, t: 44, b: 52 },
          ...baseLayout,
          xaxis: {
            gridcolor: grid,
            zerolinecolor: grid,
            ...(typeof baseLayout.xaxis === 'object' && baseLayout.xaxis ? (baseLayout.xaxis as Record<string, unknown>) : {}),
          },
          yaxis: {
            gridcolor: grid,
            zerolinecolor: grid,
            ...(typeof baseLayout.yaxis === 'object' && baseLayout.yaxis ? (baseLayout.yaxis as Record<string, unknown>) : {}),
            ...(logY ? { type: 'log' } : {}),
          },
        };

        await Plotly.newPlot(el, payload.data ?? [], mergedLayout, {
          responsive: true,
          displaylogo: false,
          modeBarButtonsToRemove: ['sendDataToCloud'],
          ...(payload.config ?? {}),
        });

        resizeObserver = new ResizeObserver(() => {
          if (containerRef.current) Plotly.Plots?.resize(containerRef.current);
        });
        resizeObserver.observe(el);
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : 'Failed to render interactive Plotly chart');
      } finally {
        if (active) setLoading(false);
      }
    }

    void renderPlot();
    return () => {
      active = false;
      resizeObserver?.disconnect();
      if (containerRef.current && plotlyRef.current) {
        try {
          plotlyRef.current.purge(containerRef.current);
        } catch {
          // ignore unmount purge error
        }
      }
    };
  }, [payload, dark, logY]);

  function exportImage(format: 'png' | 'svg') {
    const el = containerRef.current;
    if (!el || !plotlyRef.current?.downloadImage) return;
    void plotlyRef.current.downloadImage(el, {
      format,
      filename: (payload.title || 'scideveloper_chart').replace(/[^a-z0-9_-]+/gi, '_').toLowerCase(),
      width: 1200,
      height: 760,
      scale: 2,
    });
  }

  return (
    <div className="viewer">
      <div className="viewer-toolbar">
        <div className="pills">
          <Pill tone="teal">Interactive Plotly</Pill>
          <Pill>{Array.isArray(payload.data) ? `${payload.data.length} trace(s)` : 'Chart'}</Pill>
        </div>
        <div className="actions">
          <button
            type="button"
            className={'btn' + (logY ? ' btn-soft-active' : '')}
            onClick={() => setLogY((v) => !v)}
          >
            Log Y
          </button>
          <button type="button" className="btn" onClick={() => setLogY(false)} title="Reset scale">
            <RotateCcw size={13} />Reset
          </button>
          <button type="button" className="btn" onClick={() => exportImage('svg')}>
            <Download size={13} />SVG
          </button>
          <button type="button" className="btn" onClick={() => exportImage('png')}>
            <Download size={13} />PNG 2x
          </button>
        </div>
      </div>

      {error && <ErrorNote>{error}</ErrorNote>}
      <div className="plotly-stage" style={{ position: 'relative', minHeight: 380 }}>
        {loading && (
          <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', zIndex: 2 }}>
            <Loading label="Rendering interactive chart…" />
          </div>
        )}
        <div ref={containerRef} style={{ width: '100%', height: 420 }} />
      </div>
    </div>
  );
}
