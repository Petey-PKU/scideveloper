import { useEffect, useMemo, useRef, useState } from 'react';
import { Pause, Play, RotateCcw, Ruler, Sparkles, Trash2 } from 'lucide-react';
import * as $3Dmol from '3dmol';
import { ErrorNote, Loading, Pill, useArtifactText } from './ui';

type RenderStyle = 'cartoon' | 'surface' | 'pocket' | 'stick';
type ColorMode = 'spectrum' | 'ssJmol' | 'chain';

interface PickedAtom {
  chain: string;
  resn: string;
  resi: number | string;
  atom: string;
  elem: string;
  x: number;
  y: number;
  z: number;
  hetflag?: boolean;
}

interface DistanceMeasurement {
  id: string;
  a: PickedAtom;
  b: PickedAtom;
  angstroms: number;
}

function summarizePdb(text: string) {
  let atomCount = 0;
  let ligandAtoms = 0;
  const chains = new Set<string>();
  const residues = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const rec = line.slice(0, 6).trim();
    if (rec === 'ENDMDL') break;
    if (rec !== 'ATOM' && rec !== 'HETATM') continue;
    atomCount++;
    const chain = line[21]?.trim() || 'A';
    const resn = line.slice(17, 20).trim();
    const resi = line.slice(22, 27).trim();
    chains.add(chain);
    residues.add(`${chain}:${resi}:${resn}`);
    if (rec === 'HETATM' && !['HOH', 'WAT', 'DOD'].includes(resn)) {
      ligandAtoms++;
    }
  }
  return { atomCount, ligandAtoms, chains: chains.size, residues: residues.size };
}

export default function Protein3DViewer({ sessionId, artifactId }: { sessionId: string; artifactId: string }) {
  const { text, error } = useArtifactText(sessionId, artifactId);
  const [style, setStyle] = useState<RenderStyle>('cartoon');
  const [color, setColor] = useState<ColorMode>('spectrum');
  const [spinning, setSpinning] = useState(false);
  const [measureMode, setMeasureMode] = useState(false);
  const [firstPick, setFirstPick] = useState<PickedAtom | null>(null);
  const [measurements, setMeasurements] = useState<DistanceMeasurement[]>([]);
  const [selectedAtom, setSelectedAtom] = useState<PickedAtom | null>(null);
  const [webglError, setWebglError] = useState('');

  const stageRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<$3Dmol.GLViewer | null>(null);
  const measureModeRef = useRef(measureMode);
  const firstPickRef = useRef<PickedAtom | null>(firstPick);

  measureModeRef.current = measureMode;
  firstPickRef.current = firstPick;

  const stats = useMemo(() => summarizePdb(text ?? ''), [text]);

  useEffect(() => {
    const container = stageRef.current;
    if (!container || !text || !stats.atomCount) return;

    setWebglError('');
    container.innerHTML = '';

    let viewer: $3Dmol.GLViewer;
    try {
      viewer = $3Dmol.createViewer(container, {
        backgroundColor: '#0c1824',
        antialias: true,
        cartoonQuality: 10,
      });
    } catch (cause) {
      setWebglError(cause instanceof Error ? cause.message : 'WebGL initialization failed');
      return;
    }

    viewerRef.current = viewer;
    viewer.addModel(text, 'pdb');

    viewer.setClickable({}, true, (atom: PickedAtom) => {
      if (!atom || typeof atom.x !== 'number') return;
      const picked: PickedAtom = {
        chain: atom.chain || 'A',
        resn: atom.resn || 'RES',
        resi: atom.resi ?? '',
        atom: atom.atom || 'CA',
        elem: atom.elem || 'C',
        x: atom.x,
        y: atom.y,
        z: atom.z,
        hetflag: atom.hetflag,
      };
      setSelectedAtom(picked);

      if (measureModeRef.current) {
        const prev = firstPickRef.current;
        if (!prev) {
          setFirstPick(picked);
        } else {
          const dist = Math.hypot(picked.x - prev.x, picked.y - prev.y, picked.z - prev.z);
          setMeasurements(curr => [
            ...curr,
            { id: `${Date.now()}_${curr.length}`, a: prev, b: picked, angstroms: dist },
          ]);
          setFirstPick(null);
        }
      }
    });

    viewer.zoomTo();
    viewer.render();

    const observer = new ResizeObserver(() => {
      try {
        viewer.resize();
        viewer.render();
      } catch {
        // ignore resize race on unmount
      }
    });
    observer.observe(container);

    return () => {
      observer.disconnect();
      try {
        viewer.spin(false);
        viewer.clear();
      } catch {
        // ignore
      }
      viewerRef.current = null;
    };
  }, [text, stats.atomCount]);

  // Apply style, color scheme, surface, and distance annotations reactively
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;

    try {
      viewer.removeAllSurfaces();
      viewer.removeAllShapes();
      viewer.removeAllLabels();
      viewer.setStyle({}, {});

      const colorSpec =
        color === 'spectrum'
          ? { color: 'spectrum' }
          : color === 'ssJmol'
            ? { colorscheme: 'ssJmol' }
            : { colorscheme: 'chain' };

      if (style === 'cartoon' || style === 'surface' || style === 'pocket') {
        viewer.setStyle({ hetflag: false }, {
          cartoon: { ...colorSpec, style: 'oval', thickness: 0.35, arrows: true },
        });
      }

      if (style === 'stick') {
        viewer.setStyle({ hetflag: false }, {
          stick: { radius: 0.16, colorscheme: color === 'chain' ? 'chain' : 'Jmol' },
        });
      }

      // Always highlight non-water ligands as crisp sticks + specular spheres
      const waterSelection = { hetflag: true, resn: ['HOH', 'WAT', 'DOD'] } as unknown as $3Dmol.AtomSelectionSpec;
      const ligandSelection = { hetflag: true, not: { resn: ['HOH', 'WAT', 'DOD'] } } as unknown as $3Dmol.AtomSelectionSpec;
      viewer.setStyle(waterSelection, {});
      viewer.setStyle(ligandSelection, {
        stick: { radius: 0.22, colorscheme: 'greenCarbon' },
        sphere: { scale: 0.28, colorscheme: 'greenCarbon' },
      });

      if (style === 'pocket' && stats.ligandAtoms > 0) {
        const pocketSelection = {
          hetflag: false,
          within: { distance: 5.0, sel: ligandSelection },
        } as unknown as $3Dmol.AtomSelectionSpec;
        viewer.addStyle(pocketSelection, {
          stick: { radius: 0.14, colorscheme: 'Jmol' },
        });
      }

      if (style === 'surface') {
        viewer.addSurface(
          $3Dmol.SurfaceType.VDW,
          { opacity: 0.52, color: '#38bdf8' },
          { hetflag: false },
        );
      }

      // Draw atom-to-atom Ångström measurements
      for (const m of measurements) {
        viewer.addCylinder({
          start: { x: m.a.x, y: m.a.y, z: m.a.z },
          end: { x: m.b.x, y: m.b.y, z: m.b.z },
          radius: 0.08,
          dashed: true,
          color: '#facc15',
          fromCap: 1,
          toCap: 1,
        });
        viewer.addLabel(`${m.angstroms.toFixed(2)} Å`, {
          position: {
            x: (m.a.x + m.b.x) / 2,
            y: (m.a.y + m.b.y) / 2,
            z: (m.a.z + m.b.z) / 2,
          },
          backgroundColor: 'rgba(12, 24, 36, 0.88)',
          fontColor: '#fef08a',
          fontSize: 12,
          borderThickness: 1,
          borderColor: '#facc15',
        });
      }

      if (selectedAtom) {
        viewer.addLabel(`${selectedAtom.resn} ${selectedAtom.resi} (${selectedAtom.atom})`, {
          position: { x: selectedAtom.x, y: selectedAtom.y, z: selectedAtom.z },
          backgroundColor: 'rgba(15, 118, 110, 0.9)',
          fontColor: '#ffffff',
          fontSize: 11,
        });
      }

      viewer.render();
    } catch {
      // ignore transient render state
    }
  }, [style, color, measurements, selectedAtom, stats.ligandAtoms]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    try {
      viewer.spin(spinning ? 'y' : false, 0.65);
    } catch {
      // ignore
    }
  }, [spinning]);

  if (error) return <ErrorNote>{error}</ErrorNote>;
  if (text === undefined) return <Loading label="Loading WebGL 3D structure…" />;
  if (!stats.atomCount) return <ErrorNote>No valid ATOM or HETATM coordinates were found.</ErrorNote>;

  return <div className="viewer">
    <div className="viewer-toolbar">
      <div className="pills">
        <label>Style
          <select value={style} onChange={e => setStyle(e.target.value as RenderStyle)}>
            <option value="cartoon">Cartoon Ribbon (WebGL)</option>
            <option value="surface">Cartoon + Surface</option>
            <option value="pocket">Ligand Binding Pocket</option>
            <option value="stick">Atomic Sticks</option>
          </select>
        </label>
        <label>Color
          <select value={color} onChange={e => setColor(e.target.value as ColorMode)}>
            <option value="spectrum">N→C Spectrum</option>
            <option value="ssJmol">Secondary Structure</option>
            <option value="chain">Chain</option>
          </select>
        </label>
      </div>
      <div className="actions">
        <button
          type="button"
          className={'btn' + (measureMode ? ' btn-soft-active' : '')}
          aria-pressed={measureMode}
          onClick={() => { setMeasureMode(m => !m); setFirstPick(null); }}
          title="Click any two atoms to measure Ångström distance"
        >
          <Ruler size={13} />{measureMode ? (firstPick ? 'Pick 2nd atom…' : 'Measuring Å') : 'Measure Å'}
        </button>
        {measurements.length > 0 && (
          <button type="button" className="btn" onClick={() => setMeasurements([])} title="Clear distance labels">
            <Trash2 size={13} />Clear ({measurements.length})
          </button>
        )}
        <button type="button" className="btn" aria-pressed={spinning} onClick={() => setSpinning(s => !s)}>
          {spinning ? <><Pause size={13} />Pause</> : <><Play size={13} />Spin</>}
        </button>
        <button type="button" className="btn" onClick={() => {
          setSpinning(false);
          setSelectedAtom(null);
          setFirstPick(null);
          viewerRef.current?.zoomTo();
          viewerRef.current?.render();
        }}>
          <RotateCcw size={13} />Reset
        </button>
      </div>
    </div>

    {webglError ? <ErrorNote>WebGL viewer error: {webglError}</ErrorNote> : (
      <div className="protein-stage">
        <div
          ref={stageRef}
          style={{ width: '100%', height: 'clamp(280px, 42vh, 460px)', position: 'relative', borderRadius: 10, overflow: 'hidden' }}
          aria-label="Interactive WebGL 3Dmol protein structure viewer"
        />
        <div className="protein-hud">
          {selectedAtom
            ? `${selectedAtom.hetflag ? 'Ligand ' : ''}Chain ${selectedAtom.chain} · ${selectedAtom.resn} ${selectedAtom.resi} · ${selectedAtom.atom} (${selectedAtom.elem})`
            : measureMode
              ? (firstPick ? `Selected ${firstPick.resn} ${firstPick.resi} — click second atom to measure Å` : 'Measure mode: click two atoms on the structure')
              : '3Dmol WebGL · Drag to rotate · Scroll to zoom · Click atom to inspect'}
        </div>
      </div>
    )}

    <div className="pills">
      <Pill tone="blue">3Dmol WebGL</Pill>
      <Pill>{stats.atomCount.toLocaleString()} atoms</Pill>
      <Pill>{stats.residues.toLocaleString()} residues</Pill>
      <Pill>{stats.chains} {stats.chains === 1 ? 'chain' : 'chains'}</Pill>
      {stats.ligandAtoms > 0 && <Pill tone="teal"><Sparkles size={11} />{stats.ligandAtoms} ligand atoms</Pill>}
      {measurements.map(m => (
        <Pill key={m.id} tone="amber">
          {m.a.resn}{m.a.resi}–{m.b.resn}{m.b.resi}: {m.angstroms.toFixed(2)} Å
        </Pill>
      ))}
    </div>
  </div>;
}
