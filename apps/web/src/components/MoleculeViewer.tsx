import { useEffect, useRef, useState } from 'react';
import { Copy, Check } from 'lucide-react';
import SmilesDrawer from 'smiles-drawer';
import type { SpillHandle } from '@scideveloper/shared';
import { Pill, SpillCard } from './ui';

interface Compound {
  id: string;
  name: string;
  smiles?: string | null;
  molecularWeight?: number | null;
  logP?: number | null;
  hBondDonors?: number | null;
  hBondAcceptors?: number | null;
}
export interface MoleculeData {
  target?: string;
  compounds: Compound[];
  spilledAssayHandle?: SpillHandle | null;
}

function SmilesStructure({ smiles, name }: { smiles: string; name: string }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const target = svgRef.current;
    if (!target || !smiles.trim()) return;
    setFailed(false);
    target.innerHTML = '';

    const isDark = document.documentElement.classList.contains('dark');
    try {
      const drawer = new SmilesDrawer.SvgDrawer({
        width: 340,
        height: 195,
        bondThickness: 1.5,
        bondLength: 18,
        shortBondLength: 0.85,
        bondSpacing: 4.2,
        fontSizeLarge: 8.5,
        fontSizeSmall: 5.5,
        padding: 18,
        compactDrawing: true,
        isomeric: true,
      });

      SmilesDrawer.parse(
        smiles,
        tree => {
          try {
            drawer.draw(tree, target, isDark ? 'dark' : 'light');
          } catch {
            setFailed(true);
          }
        },
        () => setFailed(true),
      );
    } catch {
      setFailed(true);
    }
  }, [smiles]);

  if (failed) {
    return <p className="muted">Structure preview unavailable for this SMILES string.</p>;
  }

  return <figure className="molecule-figure">
    <svg
      ref={svgRef}
      role="img"
      aria-label={`2D chemical structure of ${name}`}
      style={{ width: '100%', maxWidth: 340, height: 195, margin: '0 auto', display: 'block' }}
    />
    <figcaption>Exact 2D chemical depiction parsed from canonical SMILES</figcaption>
  </figure>;
}

function CompoundCard({ compound }: { compound: Compound }) {
  const [copied, setCopied] = useState(false);
  const checks = [
    [compound.molecularWeight, 500],
    [compound.logP, 5],
    [compound.hBondDonors, 5],
    [compound.hBondAcceptors, 10],
  ] as const;
  const violations = checks.filter(([value, max]) => value != null && value > max).length;
  const complete = checks.every(([value]) => value != null && Number.isFinite(value));
  const status = violations
    ? `Lipinski · ${violations}${complete ? '' : '+'} ${violations === 1 && complete ? 'violation' : 'violations'}`
    : complete
      ? 'Lipinski · Pass'
      : 'Lipinski · Partial';

  async function copy(smiles: string) {
    try {
      await navigator.clipboard.writeText(smiles);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Fallback: user can select text directly
    }
  }

  return <article className="molecule-card">
    <div className="card-head">
      <h3>{compound.name}</h3>
      <Pill tone="blue">{compound.id}</Pill>
    </div>
    {compound.smiles && <>
      <SmilesStructure smiles={compound.smiles} name={compound.name} />
      <div className="smiles">
        <code>{compound.smiles}</code>
        <button type="button" className="icon-btn" aria-label={`Copy ${compound.name} SMILES`} onClick={() => void copy(compound.smiles!)}>
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
      </div>
    </>}
    <div className="pills">
      <Pill>MW {compound.molecularWeight?.toFixed(2) ?? '—'}</Pill>
      <Pill>LogP {compound.logP?.toFixed(2) ?? '—'}</Pill>
      <Pill tone={violations ? 'amber' : 'teal'}>{status}</Pill>
    </div>
  </article>;
}

export default function MoleculeViewer({ data }: { data: MoleculeData }) {
  return <div className="stack">
    {data.spilledAssayHandle && <SpillCard handle={data.spilledAssayHandle} />}
    {!data.compounds.length && <p className="muted">No curated compounds in this artifact.</p>}
    {data.compounds.map((compound, index) => <CompoundCard key={compound.id + ':' + index} compound={compound} />)}
  </div>;
}
