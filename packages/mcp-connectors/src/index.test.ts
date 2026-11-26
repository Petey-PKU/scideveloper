import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  alphafoldDb, builtInConnectors, callExternalMcpTool, cbioportal, clinicaltrials, ConnectorRegistry, elnBenchling,
  kegg, openalex, openTargets, pubchem, rcsbPdb, reactome, SpillManager, stringDb, zotero,
} from './index.js';

let spillDir: string;
let registry: ConnectorRegistry;
const offline = { allowLive: false };
const inline = { ...offline, maxBytes: Infinity, maxLines: Infinity };

beforeEach(() => {
  spillDir = mkdtempSync(join(tmpdir(), 'scideveloper-spills-'));
  registry = new ConnectorRegistry({ spillDir });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(spillDir, { recursive: true, force: true });
});

describe('SpillManager', () => {
  it('writes complete UTF-8 JSON and returns a SHA-256 and a compact handle', () => {
    const manager = new SpillManager({ spillDir, maxBytes: 100 });
    const payload = Array.from({ length: 8 }, (_, id) => ({ id, symbol: 'β' }));
    const result = manager.maybeSpill(payload, 'json', 'Gene hits');
    expect(result.spilled).toBe(true);
    expect(result.data).toBeUndefined();
    const handle = result.spillHandle!;
    const bytes = readFileSync(handle.filePath);
    expect(handle.filePath).toBe(join(spillDir, `${handle.spillId}.json`));
    expect(handle.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(handle.byteSize).toBe(bytes.byteLength);
    const content = bytes.toString('utf8');
    expect(JSON.parse(content)).toEqual(payload);
    expect(handle.lineCount).toBe(content.split('\n').length);
    expect(handle.previewLines).toEqual(content.split('\n').slice(0, 12));
    expect(handle.schemaSummary).toContain('JSON array length: 8');
    expect(handle.schemaSummary).toContain('id, symbol');
  });

  it('spills CSV by line count and handles quoted multiline fields', () => {
    const manager = new SpillManager({ spillDir, maxLines: 2 });
    const payload = 'gene,description\r\nEGFR,"first\r\nsecond"\r\nTP53,"has ""quotes"""\r\n';
    const handle = manager.maybeSpill(payload, 'csv').spillHandle!;
    const bytes = readFileSync(handle.filePath);
    expect(bytes.toString('utf8')).toBe(payload);
    expect(handle.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(handle.lineCount).toBe(4);
    expect(handle.schemaSummary).toContain('CSV headers: gene,description; 2 data rows');
  });

  it('keeps small payloads inline without writing files', () => {
    const manager = new SpillManager({ spillDir, maxBytes: 3, maxLines: 1 });
    expect(manager.maybeSpill('βx', 'txt')).toEqual({ spilled: false, data: 'βx' });
    expect(new SpillManager({ spillDir }).maybeSpill({ gene: 'EGFR' }, 'json'))
      .toEqual({ spilled: false, data: { gene: 'EGFR' } });
    expect(readdirSync(spillDir)).toEqual([]);
  });
});

describe('ConnectorRegistry', () => {
  it('lists all nineteen built-in connectors with the expected categories and operations', () => {
    const catalog = registry.listConnectors();
    expect(catalog.map(info => info.id)).toEqual([
      'pubmed', 'rcsb-pdb', 'uniprot', 'chembl', 'ensembl', 'clinvar', 'geo', 'arxiv-biorxiv',
      'string-db', 'kegg', 'reactome', 'alphafold-db', 'cbioportal', 'opentargets', 'pubchem', 'eln-benchling',
      'clinicaltrials', 'openalex', 'zotero',
    ]);
    expect(catalog.slice(8).map(info => [info.category, info.operations])).toEqual([
      ['protein', ['interaction_partners', 'network_enrichment']],
      ['pathways', ['search_pathway', 'get_pathway']],
      ['pathways', ['search_pathways', 'enrich_genes']],
      ['structural', ['fetch_prediction', 'confidence_summary']],
      ['clinical', ['list_studies', 'gene_alterations']],
      ['clinical', ['target_diseases', 'known_drugs']],
      ['chemistry', ['search_compound', 'compound_properties']],
      ['eln', ['list_experiments', 'fetch_protocol', 'register_sample']],
      ['clinical', ['search_trials', 'get_trial']],
      ['literature', ['search_works', 'get_work', 'cited_by']],
      ['literature', ['search_items', 'get_item', 'list_collections']],
    ]);
    expect(builtInConnectors.slice(8)).toEqual([
      stringDb, kegg, reactome, alphafoldDb, cbioportal, openTargets, pubchem, elnBenchling, clinicaltrials, openalex, zotero,
    ]);
  });

  it.each([
    ['biorxiv', 'arxiv-biorxiv', 'search_preprints', { query: 'SARS-CoV-2' }],
    ['string', 'string-db', 'interaction_partners', { protein: 'EGFR' }],
  ])('resolves the %s skill recommendation to %s', async (alias, canonical, operation, params) => {
    const recommended = await registry.query(alias, operation, params, inline);
    const direct = await registry.query(canonical, operation, params, inline);
    expect(recommended.data).toEqual(direct.data);
  });

  it('searches PubMed and retrieves an annotated abstract', async () => {
    const articles = await registry.query('pubmed', 'search', { query: 'EGFR AND lung cancer' }, inline);
    expect(articles.source).toBe('offline-fallback');
    expect(articles.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ pmid: '15118073', doi: '10.1056/NEJMoa040938', year: 2004 }),
    ]));
    const fetched = await registry.query('pubmed', 'fetch_abstract', { pmid: '34265844' }, offline);
    expect(fetched.data).toMatchObject({ abstract: expect.stringContaining('AlphaFold'), abstractKind: 'curated-summary' });
  });

  it('finds authentic PDB metadata and returns real fixed-column coordinates', async () => {
    const search = await registry.query('rcsb-pdb', 'search', { query: 'EGFR' }, offline);
    expect(search.data).toEqual([expect.objectContaining({ pdbId: '1M17', resolution: 2.6 })]);
    for (const id of ['1M17', '1TUP', '6LU7']) {
      const { data, format } = await rcsbPdb.execute('fetch_structure', { id }, offline);
      expect(format).toBe('pdb');
      const pdb = String(data);
      expect(pdb).toMatch(/^HELIX /m);
      expect(pdb).toMatch(/^SHEET /m);
      expect(pdb).toMatch(/^HETATM/m);
      const atoms = pdb.split('\n').filter(line => line.startsWith('ATOM  '));
      const coordinates = atoms.map(atom => [30, 38, 46].map(offset => Number(atom.slice(offset, offset + 8))));
      expect(coordinates.every(point => point.every(Number.isFinite))).toBe(true);
      expect(new Set(coordinates.map(point => point.join(','))).size).toBeGreaterThan(100);
      if (id === '1TUP') expect(atoms.map(line => line[21])).toEqual(expect.arrayContaining(['A', 'B']));
    }
  });

  it('searches UniProt and fetches canonical sequence and annotations', async () => {
    const search = await registry.query('uniprot', 'search', { query: 'BRCA1' }, inline);
    expect(search.data).toEqual([expect.objectContaining({ accession: 'P38398', length: 1863 })]);
    const { data } = await registry.query('uniprot', 'fetch_entry', { accession: 'P04637' }, inline);
    expect(data).toMatchObject({
      accession: 'P04637', gene: 'TP53', sequence: expect.stringMatching(/^[A-Z]{393}$/),
      domains: expect.arrayContaining([expect.objectContaining({ start: expect.any(Number), end: expect.any(Number) })]),
      function: expect.stringContaining('tumor suppressor'),
    });
  });

  it('finds ChEMBL compounds and measured IC50 assay records', async () => {
    const compounds = await registry.query('chembl', 'search_compound', { name: 'Osimertinib' }, offline);
    expect(compounds.data).toEqual([expect.objectContaining({
      id: 'CHEMBL3353410', smiles: expect.stringContaining('C=CC(=O)'), molecularWeight: 499.62, logP: 4.51,
    })]);
    const { data } = await registry.query('chembl', 'bioactivity', { chemblId: 'CHEMBL939' }, inline);
    expect(data).toEqual(expect.arrayContaining([expect.objectContaining({
      compoundId: 'CHEMBL939', targetId: 'CHEMBL203', type: 'IC50',
      assayId: expect.stringMatching(/^CHEMBL\d+$/), value: expect.any(Number), units: 'nM',
    })]));
  });

  it('spills bulk assay data automatically and honors per-query thresholds', async () => {
    const query = await registry.query('chembl', 'bulk_assay', {}, offline);
    expect(query).toMatchObject({ spilled: true, source: 'offline-fallback' });
    expect(query.data).toBeUndefined();
    const handle = query.spillHandle!;
    expect(handle.format).toBe('csv');
    expect(handle.schemaSummary).toContain('250 data rows');
    expect(readFileSync(handle.filePath, 'utf8').split('\n')).toHaveLength(251);
    const unspilled = await registry.query('chembl', 'bulk_assay', {}, inline);
    expect(unspilled.spilled).toBe(false);
    expect(unspilled.data).toBe(readFileSync(handle.filePath, 'utf8'));
  });

  it('returns Ensembl gene intervals and demo coverage with bounded bins', async () => {
    const lookup = await registry.query('ensembl', 'fetch_gene', { id: 'ENSG00000141510' }, inline);
    expect(lookup.data).toMatchObject({
      symbol: 'TP53', chromosome: '17', strand: -1, assembly: 'GRCh38',
      transcripts: expect.arrayContaining([expect.objectContaining({ exons: expect.any(Array) })]),
    });
    const { data } = await registry.query('ensembl', 'genome_track', { gene: 'MYC' }, inline);
    const track = data as { start: number; end: number; tracks: Array<{ id: string; simulated: boolean; values: Array<{ start: number; end: number }> }> };
    expect(track.tracks.map(series => series.id)).toEqual(['chip-seq', 'rna-seq']);
    for (const series of track.tracks) {
      expect(series.simulated).toBe(true);
      expect(series.values[0].start).toBe(track.start);
      expect(series.values.at(-1)?.end).toBe(track.end);
    }
  });

  it('verifies known PMIDs and DOIs and rejects fabricated identifiers', async () => {
    await expect(registry.verifyCitation('PMID: 15118073', offline))
      .resolves.toMatchObject({ verified: true, title: expect.stringContaining('Activating mutations'), source: 'offline-fallback' });
    await expect(registry.verifyCitation('https://doi.org/10.1056/NEJMoa2212948', offline))
      .resolves.toMatchObject({ verified: true, title: "Lecanemab in Early Alzheimer's Disease." });
    await expect(registry.verifyCitation('999999999', offline)).resolves.toMatchObject({ verified: false });
    await expect(registry.verifyCitation('15118073 fabricated', offline)).resolves.toMatchObject({ verified: false });
  });

  it('registers external HTTP and stdio configuration defensively', () => {
    const remote = { id: 'lab', name: 'Lab MCP', transport: 'http', url: 'https://example.test/mcp', enabled: true } as const;
    const local = { id: 'local', name: 'Local MCP', transport: 'stdio' as const, command: 'lab-server', args: ['--stdio'], enabled: false };
    expect(registry.registerExternalServer(remote)).toEqual(remote);
    expect(registry.registerExternalServer(local)).toEqual(local);
    local.args.push('--other');
    expect(registry.listExternalServers()).toEqual([remote, { ...local, args: ['--stdio'] }]);
    expect(registry.listConnectors()).toContainEqual(expect.objectContaining({ id: 'lab', category: 'external-mcp', status: 'configured' }));
    expect(() => registry.registerExternalServer({ ...remote, id: 'pubmed' })).toThrow('built in');
  });
});

describe('Expanded scientific connectors', () => {
  it('returns curated STRING partners, evidence and single-protein network expansion', async () => {
    for (const gene of ['EGFR', 'TP53', 'BRCA1', 'KRAS']) {
      const edges = await registry.query('string-db', 'interaction_partners', { gene, limit: 3 }, inline);
      expect(edges.data).toHaveLength(3);
      expect(edges.data).toEqual(expect.arrayContaining([expect.objectContaining({
        proteinA: gene, taxonId: 9606, score: expect.any(Number),
        evidence: expect.any(Object),
      })]));
    }
    const edges = await registry.query('string-db', 'interaction_partners', { gene: 'P38398', required_score: 990 }, inline);
    expect(edges.data).toContainEqual(expect.objectContaining({
      proteinB: 'BARD1', evidence: { experimental: 0.998, database: 0.9, textmining: 0.992 },
    }));
    const enrichment = await registry.query('string-db', 'network_enrichment', { gene: 'EGFR' }, inline);
    expect(enrichment.data).toMatchObject({ expandedNeighbors: expect.arrayContaining(['ERBB2']), pathways: expect.any(Array) });
  });

  it('searches and retrieves all four curated KEGG pathways', async () => {
    const hits = await registry.query('kegg', 'search_pathway', { query: 'EGFR inhibitor resistance' }, inline);
    expect(hits.data).toEqual([expect.objectContaining({ id: 'hsa01521' })]);
    for (const [pathwayId, symbol] of [['hsa01521', 'EGFR'], ['hsa04115', 'TP53'], ['hsa05223', 'KRAS'], ['hsa04010', 'MAPK1']]) {
      const pathway = await registry.query('kegg', 'get_pathway', { pathwayId: `path:${pathwayId}` }, inline);
      expect(pathway.data).toMatchObject({
        id: pathwayId, genes: expect.arrayContaining([expect.objectContaining({ symbol, entrezGeneId: expect.any(Number) })]),
      });
    }
    await expect(registry.query('kegg', 'get_pathway', { id: 'mmu04115' }, offline)).rejects.toThrow('human KEGG pathway ID');
  });

  it('applies one-sided hypergeometric enrichment and BH across the tested Reactome pathways', async () => {
    const catalog = await registry.query('reactome', 'search_pathways', {}, inline);
    expect(catalog.data).toEqual(expect.arrayContaining(['R-HSA-177929', 'R-HSA-3700989', 'R-HSA-5683057', 'R-HSA-1640170']
      .map(id => expect.objectContaining({ id }))));
    const background = ['EGFR', 'AREG', 'TP53', 'CDK1', 'BRAF', 'X'];
    const params = { genes: ['egfr', 'AREG', 'EGFR', 'UNMAPPED'], background };
    const a = await registry.query('reactome', 'enrich_genes', params, inline);
    const b = await registry.query('reactome', 'enrich_genes', { ...params, limit: 1 }, inline);
    const first = { id: 'R-HSA-177929', overlapGenes: ['AREG', 'EGFR'], overlapCount: 2, pathwaySize: 2 };
    expect(a.data).toMatchObject({ universeSize: 6, querySize: 2, testedPathways: 4, unmappedGenes: ['UNMAPPED'],
      pathways: [expect.objectContaining(first), expect.objectContaining({ id: 'R-HSA-5683057' })] });
    expect(b.data).toMatchObject({ pathways: [expect.objectContaining(first)] });
    const [top] = (b.data as { pathways: Array<{ pValue: number; fdr: number }> }).pathways;
    expect(top.pValue).toBeCloseTo(1 / 15);
    expect(top.fdr).toBeCloseTo(4 / 15);
  });

  it('loads versioned AlphaFold metadata and domain ranges for all four accessions', async () => {
    for (const [uniprotId, meanPlddt] of [['P00533', 75.94], ['P04637', 75.06], ['P38398', 41.59], ['P01116', 91.52]]) {
      for (const operation of ['fetch_prediction', 'confidence_summary']) {
        const prediction = await registry.query('alphafold-db', operation, { uniprotId }, inline);
        expect(prediction.data).toMatchObject({
          modelId: `AF-${uniprotId}-F1`, meanPlddt, version: 6, pdbUrl: expect.stringMatching(/model_v6\.pdb$/),
          cifUrl: expect.stringMatching(/model_v6\.cif$/), domains: expect.arrayContaining([
            expect.objectContaining({ name: expect.any(String), start: expect.any(Number), end: expect.any(Number) }),
          ]),
        });
      }
    }
  });

  it('reports sourced cBioPortal frequencies and exposes uncataloged gene/cohort pairs', async () => {
    const { data } = await registry.query('cbioportal', 'list_studies', {}, inline);
    expect(data).toEqual(expect.arrayContaining(['luad_tcga_pan_can_atlas_2018', 'brca_tcga_pan_can_atlas_2018', 'msk_impact_2017']
      .map(studyId => expect.objectContaining({ studyId }))));
    const luad = await registry.query('cbioportal', 'gene_alterations', { genes: ['EGFR', 'KRAS', 'NOTCURATED'] }, inline);
    expect(luad.data).toMatchObject({
      unavailableGenes: ['NOTCURATED'], alterations: [
        { gene: 'EGFR', alteredCount: 69, profiledCount: 566, frequency: 69 / 566, unit: 'patient' },
        { gene: 'KRAS', alteredCount: 168 },
      ],
    });
    const breast = await registry.query('cbioportal', 'gene_alterations',
      { studyId: 'brca_tcga_pan_can_atlas_2018', genes: ['BRCA1', 'PIK3CA'] }, inline);
    expect(breast.data).toMatchObject({ alterations: [{ alteredCount: 27 }, { alteredCount: 346 }] });
    const impact = await registry.query('cbioportal', 'gene_alterations', { studyId: 'msk_impact_2017', gene: 'KRAS' }, inline);
    expect(impact.data).toMatchObject({ alterations: [
      { gene: 'KRAS', frequencyPercent: 15, measure: 'published aggregate alterations', rounded: true },
    ] });
  });

  it('reports curated Open Targets evidence coverage and approved biomarker-linked drugs', async () => {
    for (const gene of ['EGFR', 'TP53', 'KRAS', 'BRCA1']) {
      const diseases = await registry.query('opentargets', 'target_diseases', { gene }, inline);
      expect(diseases.data).toMatchObject({
        symbol: gene, scoreMethod: expect.stringContaining('Curated evidence presence'),
        associations: expect.arrayContaining([expect.objectContaining({ disease: { id: expect.any(String), name: expect.any(String) } })]),
      });
    }
    const drugs = await registry.query('opentargets', 'known_drugs', { targetId: 'ENSG00000012048' }, inline);
    expect(drugs.data).toMatchObject({ drugs: expect.arrayContaining([expect.objectContaining({
      drug: { id: 'CHEMBL521686', name: 'Olaparib' }, phase: 4, role: 'BRCA1 is a biomarker',
    })]) });
  });

  it('returns all five PubChem compounds with identity, descriptor and safety metadata', async () => {
    for (const [name, cid] of [['Gefitinib', 123631], ['Osimertinib', 71496458], ['Erlotinib', 176870], ['Sotorasib', 137278711], ['Aspirin', 2244]]) {
      const hits = await registry.query('pubchem', 'search_compound', { name }, inline);
      expect(hits.data).toEqual([expect.objectContaining({ cid, name })]);
      const properties = await registry.query('pubchem', 'compound_properties', { cid }, inline);
      expect(properties.data).toMatchObject({
        cid, iupacName: expect.any(String), molecularFormula: expect.any(String), canonicalSmiles: expect.any(String),
        tpsa: expect.any(Number), hbd: expect.any(Number), hba: expect.any(Number), rotatableBonds: expect.any(Number),
        ghsSafety: { statements: expect.any(Array) }, conformers: { sdfUrl: expect.stringContaining('record_type=3d') },
      });
    }
  });

  it('assigns unique ELN sample IDs, deduplicates request IDs and exposes registry-local changes', async () => {
    for (const id of ['SOP-VIA-001', 'SOP-RNA-002']) {
      const protocol = await registry.query('eln-benchling', 'fetch_protocol', { id }, inline);
      expect(protocol.data).toMatchObject({ id, steps: expect.any(Array), qualityChecks: expect.any(Array) });
    }
    const params = { name: 'RNA replicate B', type: 'total RNA', experimentId: 'EXP-2026-002', requestId: 'rna-b' };
    const registrations = await Promise.all([
      registry.query('eln-benchling', 'register_sample', params, inline),
      registry.query('eln-benchling', 'register_sample', params, inline),
      registry.query('eln-benchling', 'register_sample', { ...params, name: 'RNA replicate C', requestId: 'rna-c' }, inline),
    ]);
    expect(registrations.map(row => (row.data as { id: string }).id)).toEqual(['SMP-2026-004', 'SMP-2026-004', 'SMP-2026-005']);
    await expect(registry.query('eln-benchling', 'register_sample', { ...params, name: 'Different sample' }, inline)).rejects.toThrow('already used');
    const experiments = await registry.query('eln-benchling', 'list_experiments', { query: 'EXP-2026-002' }, inline);
    expect(experiments.data).toEqual([expect.objectContaining({ samples: expect.arrayContaining([
      expect.objectContaining({ id: 'SMP-2026-003' }), expect.objectContaining({ id: 'SMP-2026-005' }),
    ]) })]);
    const fresh = new ConnectorRegistry({ spillDir });
    expect((await fresh.query('eln-benchling', 'list_experiments', { query: 'EXP-2026-002' }, inline)).data)
      .toEqual([expect.objectContaining({ samples: [expect.objectContaining({ id: 'SMP-2026-003' })] })]);
  });
});

describe('Live scientific connector requests', () => {
  const live = { allowLive: true, maxBytes: Infinity, maxLines: Infinity };

  it('requests STRING with a four-second deadline and falls back on transport failure', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json([{
      stringId_A: '9606.ENSP00000275493', stringId_B: '9606.ENSP00000269571',
      preferredName_A: 'EGFR', preferredName_B: 'ERBB2', ncbiTaxonId: 9606,
      score: 0.999, escore: 0.98, dscore: 0.9, tscore: 0.99,
    }])).mockRejectedValueOnce(new TypeError('fetch failed'));
    const response = await registry.query('string-db', 'interaction_partners', { genes: ['EGFR', 'KRAS'], limit: 5 }, live);
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.pathname).toBe('/api/json/interaction_partners');
    expect(url.searchParams.get('identifiers')).toBe('EGFR\rKRAS');
    expect(timeout).toHaveBeenCalledWith(4000);
    expect(fetchMock.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
    expect(response).toMatchObject({ source: 'live', data: [{ proteinB: 'ERBB2', evidence: { experimental: 0.98 } }] });
    await expect(registry.query('string-db', 'interaction_partners', { gene: 'EGFR' }, live))
      .resolves.toMatchObject({ source: 'offline-fallback' });
  });

  it('parses KEGG flat-file records and posts Reactome gene lists as text', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('ENTRY       hsa01521                    Pathway\nNAME        EGFR tyrosine kinase inhibitor resistance - Homo sapiens (human)\nGENE        1956  EGFR; epidermal growth factor receptor [KO:K04361]\n            3845  KRAS; GTPase KRas\n///\n'))
      .mockResolvedValueOnce(Response.json({
        pathways: [{ stId: 'R-HSA-177929', name: 'Signaling by EGFR', entities: { found: 2, total: 53, pValue: 0.01, fdr: 0.12 } }],
        identifiersNotFound: 0, summary: { token: 'mock-analysis' },
      }));
    await expect(registry.query('kegg', 'get_pathway', { id: 'hsa01521' }, live))
      .resolves.toMatchObject({ source: 'live', data: { genes: [
        { symbol: 'EGFR', entrezGeneId: 1956, name: 'epidermal growth factor receptor' },
        { symbol: 'KRAS', entrezGeneId: 3845 },
      ] } });
    await expect(registry.query('reactome', 'enrich_genes', { genes: 'EGFR,KRAS' }, live))
      .resolves.toMatchObject({ source: 'live', data: { analysisToken: 'mock-analysis', pathways: [{ overlapCount: 2, fdr: 0.12 }] } });
    expect(fetchMock.mock.calls[1][1]).toMatchObject({
      method: 'POST', body: 'EGFR\nKRAS', headers: { 'Content-Type': 'text/plain' },
    });
  });

  it('chooses the canonical AlphaFold model and calculates confidence relative to the model range', async () => {
    const model = {
      modelEntityId: 'AF-P00533-F1', uniprotAccession: 'P00533', gene: 'EGFR', latestVersion: 6,
      sequenceStart: 712, sequenceEnd: 715, pdbUrl: 'https://alphafold.ebi.ac.uk/files/model.pdb',
      cifUrl: 'https://alphafold.ebi.ac.uk/files/model.cif',
      plddtDocUrl: 'https://alphafold.ebi.ac.uk/files/AF-P00533-F1-confidence_v6.json',
    };
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(Response.json([{ ...model, modelEntityId: 'AF-P00533-2-F1', uniprotAccession: 'P00533-2' }, model]))
      .mockResolvedValueOnce(Response.json({ confidenceScore: [50, 70, 90, 100] }));
    await expect(registry.query('alphafold-db', 'confidence_summary', { accession: 'P00533' }, live))
      .resolves.toMatchObject({ source: 'live', data: {
        modelId: 'AF-P00533-F1', meanPlddt: 77.5,
        domains: [{ name: 'Protein kinase', meanPlddt: 77.5, residueCount: 4,
          confidenceCounts: { veryLow: 1, low: 1, confident: 1, veryHigh: 1 } }],
      } });
  });

  it('counts unique mutated samples only among the samples profiled for that gene', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const { pathname } = new URL(String(input));
      if (pathname.endsWith('/gene-panel-data')) return Response.json([
        { sampleId: 'A', profiled: true, genePanelId: 'panel1' },
        { sampleId: 'B', profiled: true, genePanelId: 'panel1' },
        { sampleId: 'C', profiled: true, genePanelId: 'panel2' },
        { sampleId: 'D', profiled: false },
      ]);
      if (pathname.endsWith('/sample-ids')) return Response.json(['A', 'B', 'C', 'D']);
      if (pathname.endsWith('/panel1')) return Response.json({ genes: [{ entrezGeneId: 1956 }] });
      if (pathname.endsWith('/panel2')) return Response.json({ genes: [{ entrezGeneId: 7157 }] });
      if (pathname.endsWith('/mutations/fetch')) return Response.json(
        ['A', 'A', 'C'].map(sampleId => ({ sampleId, entrezGeneId: 1956 })));
      throw new Error('Unexpected URL');
    });
    await expect(registry.query('cbioportal', 'gene_alterations', { gene: 'EGFR' }, live))
      .resolves.toMatchObject({ source: 'live', data: {
        alterations: [{ gene: 'EGFR', alteredCount: 1, profiledCount: 2, frequency: 0.5, frequencyPercent: 50 }],
      } });
    const [, mutationRequest] = fetchMock.mock.calls.find(([input]) => String(input).includes('/mutations/fetch'))!;
    expect(JSON.parse(String(mutationRequest?.body))).toEqual({
      sampleListId: 'luad_tcga_pan_can_atlas_2018_sequenced', entrezGeneIds: [1956],
    });
  });

  it('normalizes Open Targets datatype scores and rejects GraphQL errors before falling back', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(Response.json({ data: { target: {
        id: 'ENSG00000146648', approvedSymbol: 'EGFR', associatedDiseases: { rows: [{
          disease: { id: 'EFO_0003060', name: 'NSCLC' }, score: 0.78,
          datatypeScores: [{ id: 'somatic_mutation', score: 0.94 }, { id: 'known_drug', score: 0.85 }],
        }] },
      } } }))
      .mockResolvedValueOnce(Response.json({ data: {}, errors: [{ message: 'upstream error' }] }));
    await expect(registry.query('opentargets', 'target_diseases', { gene: 'EGFR' }, live))
      .resolves.toMatchObject({ source: 'live', data: { associations: [{ score: 0.78, evidenceScores: { genetic: null, somatic: 0.94, drug: 0.85 } }] } });
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).variables.id).toBe('ENSG00000146648');
    await expect(registry.query('opentargets', 'known_drugs', { gene: 'EGFR' }, live))
      .resolves.toMatchObject({ source: 'offline-fallback', data: { drugs: expect.any(Array) } });
  });

  it('parses PubChem properties, PUG View GHS statements and conformer identifiers', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(Response.json({ PropertyTable: { Properties: [{
        CID: 2244, Title: 'Aspirin', IUPACName: '2-acetyloxybenzoic acid', MolecularFormula: 'C9H8O4',
        ConnectivitySMILES: 'CC(=O)OC1=CC=CC=C1C(=O)O', TPSA: 63.6, HBondDonorCount: 1,
        HBondAcceptorCount: 4, RotatableBondCount: 3,
      }] } }))
      .mockResolvedValueOnce(Response.json({ Record: { Section: [{ Information: [
        { Name: 'GHS Hazard Statements', Value: { StringWithMarkup: [{ String: 'H302: Harmful if swallowed' }] } },
      ] }] } }))
      .mockResolvedValueOnce(Response.json({ IdentifierList: { ConformerID: ['000008C400000001'] } }));
    await expect(registry.query('pubchem', 'compound_properties', { cid: 2244 }, live))
      .resolves.toMatchObject({ source: 'live', data: {
        cid: 2244, ghsSafety: { statements: ['H302: Harmful if swallowed'] },
        conformers: { ids: ['000008C400000001'] },
      } });
  });

  it('uses the configured ELN adapter and surfaces an uncertain live write without creating a demo record', async () => {
    vi.stubEnv('SCIDEV_ELN_URL', 'https://lab.example.test/v1/');
    vi.stubEnv('SCIDEV_ELN_TOKEN', 'test-token');
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(Response.json([{ id: 'exp-live' }]))
      .mockResolvedValueOnce(Response.json({ id: 'smp-live' }))
      .mockRejectedValueOnce(new Error('network interrupted'));
    await expect(registry.query('eln-benchling', 'list_experiments', {}, live))
      .resolves.toMatchObject({ source: 'live', data: [{ id: 'exp-live' }] });
    const params = { name: 'Live sample', type: 'total RNA', experimentId: 'EXP-2026-002', requestId: 'live-rna' };
    await expect(registry.query('eln-benchling', 'register_sample', params, live))
      .resolves.toMatchObject({ source: 'live', data: { id: 'smp-live' } });
    expect(fetchMock).toHaveBeenNthCalledWith(2, 'https://lab.example.test/v1/samples', expect.objectContaining({
      method: 'POST', headers: expect.objectContaining({ Authorization: 'Bearer test-token', 'Idempotency-Key': 'live-rna' }),
    }));
    await expect(registry.query('eln-benchling', 'register_sample', params, live)).rejects.toThrow('Could not confirm live ELN registration');
    await expect(registry.query('eln-benchling', 'register_sample', params, inline))
      .resolves.toMatchObject({ source: 'offline-fallback', data: { id: 'SMP-2026-004' } });
  });
});

describe('Clinical and literature connectors', () => {
  it('searches and fetches curated ClinVar records by gene, variation ID and VCV accession', async () => {
    const hits = await registry.query('clinvar', 'search_variants', { query: 'EGFR' }, offline);
    expect(hits).toMatchObject({ source: 'offline-fallback', data: [
      { variationId: '16609', variant: expect.stringContaining('Leu858Arg') },
      { variationId: '16613', variant: expect.stringContaining('Thr790Met') },
    ] });
    const tp53 = await registry.query('clinvar', 'fetch_variant', { accession: 'VCV000012374.88' }, offline);
    expect(tp53.data).toMatchObject({ variationId: '12374', condition: 'Li-Fraumeni syndrome',
      clinicalSignificance: 'Pathogenic', reviewStatus: 'reviewed by expert panel', classificationType: 'germline' });
    const brca1 = await registry.query('clinvar', 'fetch_variant', { variant: 'BRCA1 c.5266dupC' }, offline);
    expect(brca1.data).toMatchObject({ variationId: '17677', gene: 'BRCA1' });
    const missing = await registry.query('clinvar', 'fetch_variant', { variationId: 123456789 }, offline);
    expect(missing.data).toBeNull();
  });

  it('searches a GEO Series by study terms and fetches deposited metadata', async () => {
    const hits = await registry.query('geo', 'search_series', { query: 'scRNA-seq' }, offline);
    expect(hits).toMatchObject({ source: 'offline-fallback', data: [
      { accession: 'GSE131907' }, { accession: 'GSE117570' }, { accession: 'GSE148071' },
    ] });
    const study = await registry.query('geo', 'fetch_series', { accession: 'gse32863' }, offline);
    expect(study.data).toMatchObject({ accession: 'GSE32863', organism: 'Homo sapiens',
      platform: 'GPL6884', sampleCount: 116, summary: expect.stringContaining('Microarray') });
    await expect(registry.query('geo', 'fetch_series', { accession: 'GSM813445' }, offline))
      .rejects.toThrow('Expected a GEO Series accession');
  });

  it('finds bioRxiv and medRxiv preprints with attributable abstracts', async () => {
    const results = await registry.query('arxiv-biorxiv', 'search_preprints', { query: 'lung cancer', limit: 1 }, offline);
    expect(results).toMatchObject({ source: 'offline-fallback', data: [{ doi: '10.1101/2019.12.08.868828',
      authors: expect.arrayContaining(['Ashley Maynard']), server: 'bioRxiv', abstractKind: 'curated-summary' }] });
    const filtered = await registry.query('arxiv-biorxiv', 'search_preprints', { server: 'MEDRXIV' }, offline);
    expect(filtered.data).toMatchObject([{ doi: '10.1101/2020.05.06.20092999', server: 'medRxiv',
      title: expect.stringContaining('OpenSAFELY'), abstract: expect.stringContaining('observational cohort') }]);
  });

  it('maps NCBI and Europe PMC responses and falls back when upstream fails', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = new URL(String(input));
      const db = url.searchParams.get('db');
      if (db === 'clinvar' && url.pathname.endsWith('esearch.fcgi')) {
        expect(url.searchParams.get('term')).toBe('TP53');
        return Response.json({ esearchresult: { idlist: ['12347'] } });
      }
      if (db === 'clinvar') {
        expect(url.searchParams.get('id')).toBe('12347');
        return Response.json({ result: { uids: ['12347'], 12347: {
          uid: '12347', accession: 'VCV000012347', title: 'NM_000546.6(TP53):c.742C>T (p.Arg248Trp)',
          germline_classification: { description: 'Pathogenic', review_status: 'reviewed by expert panel',
            trait_set: [{ trait_name: 'Li-Fraumeni syndrome' }] },
        } } });
      }
      if (db === 'gds' && url.pathname.endsWith('esearch.fcgi')) {
        expect(url.searchParams.get('term')).toBe('(GSE148071[ACCN]) AND gse[ETYP]');
        return Response.json({ esearchresult: { idlist: ['200148071'] } });
      }
      if (db === 'gds') return Response.json({ result: { uids: ['200148071'], 200148071: {
        accession: 'GSE148071', title: 'Comprehensive Profiling of Cancer Cells and Their Microenvironment in Advanced NSCLC',
        gpl: '20795', n_samples: 42, taxon: 'Homo sapiens', summary: 'Single-cell RNA sequencing of advanced NSCLC',
      } } });
      expect(url.searchParams.get('query')).toBe('SRC:PPR AND (PUBLISHER:"bioRxiv" OR PUBLISHER:"medRxiv") AND (single cell)');
      return Response.json({ resultList: { result: [{ doi: '10.1101/460147', title: 'Comprehensive integration of single cell data',
        bookOrReportDetails: { publisher: 'bioRxiv' }, authorList: { author: [{ fullName: 'Tim Stuart' }] }, abstractText: 'Integration of single cell datasets.',
      }] } });
    });
    const live = { allowLive: true };
    await expect(registry.query('clinvar', 'search_variants', { query: 'TP53' }, live)).resolves.toMatchObject({
      source: 'live', data: [{ variationId: '12347', gene: 'TP53', condition: 'Li-Fraumeni syndrome' }],
    });
    await expect(registry.query('geo', 'fetch_series', { accession: 'GSE148071' }, live)).resolves.toMatchObject({
      source: 'live', data: { platform: 'GPL20795', organism: 'Homo sapiens', sampleCount: 42 },
    });
    await expect(registry.query('arxiv-biorxiv', 'search_preprints', { query: 'single cell' }, live)).resolves.toMatchObject({
      source: 'live', data: [{ doi: '10.1101/460147', server: 'bioRxiv', authors: ['Tim Stuart'], abstractKind: 'publisher' }],
    });
    fetch.mockResolvedValueOnce(new Response(null, { status: 503 }));
    await expect(registry.query('geo', 'fetch_series', { accession: 'GSE148071' }, live)).resolves.toMatchObject({
      source: 'offline-fallback', data: { platform: 'GPL20795', sampleCount: 42 },
    });
  });
});

describe('ClinicalTrials.gov, OpenAlex and Zotero', () => {
  it('searches curated trials by terms, phase and status and retrieves individual registrations', async () => {
    const params = { query: 'EGFR', condition: 'lung cancer', intervention: 'osimertinib', phase: 'Phase III', status: 'active not recruiting' };
    const search = await registry.query('clinicaltrials', 'search_trials', { ...params, maxResults: 1 }, inline);
    expect(search).toMatchObject({ source: 'offline-fallback', data: [
      { nctId: 'NCT04035486', acronym: 'FLAURA2', phase: ['PHASE3'], status: 'ACTIVE_NOT_RECRUITING',
        enrollment: { count: 587, type: 'ACTUAL' }, sponsor: 'AstraZeneca' },
    ] });
    expect((await registry.query('clinicaltrials', 'search_trials', { ...params, phase: 'Phase 2' }, inline)).data).toEqual([]);
    const detail = await registry.query('clinicaltrials', 'get_trial', { nctId: 'nct02578680' }, inline);
    expect(detail.data).toMatchObject({
      acronym: 'KEYNOTE-189', conditions: [expect.stringContaining('lung cancer')],
      interventions: expect.arrayContaining(['Pembrolizumab']),
      primaryOutcomes: [{ measure: 'Overall survival' }, { measure: 'Progression-free survival' }],
    });
    expect((await registry.query('clinicaltrials', 'get_trial', { nctId: 'NCT04487080' }, inline)).data)
      .toMatchObject({ acronym: 'MARIPOSA', enrollment: { count: 1074 } });
  });

  it('uses the v2 search filters and study endpoint, normalizes studies and falls back on HTTP errors', async () => {
    const upstream = { protocolSection: {
      identificationModule: { nctId: 'NCT04487080', acronym: 'MARIPOSA', briefTitle: 'A live trial' },
      statusModule: { overallStatus: 'ACTIVE_NOT_RECRUITING' },
      designModule: { phases: ['PHASE3'], enrollmentInfo: { count: 1074, type: 'ACTUAL' } },
      sponsorCollaboratorsModule: { leadSponsor: { name: 'Janssen' } },
      conditionsModule: { conditions: ['NSCLC'] },
      armsInterventionsModule: { interventions: [{ name: 'Lazertinib' }] },
      outcomesModule: { primaryOutcomes: [{ measure: 'Progression-free survival', timeFrame: 'Up to 3 years' }] },
    } };
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(Response.json({ studies: [upstream] }))
      .mockResolvedValueOnce(Response.json(upstream))
      .mockResolvedValueOnce(new Response(null, { status: 503 }));
    const live = { ...inline, allowLive: true };
    const search = await registry.query('clinicaltrials', 'search_trials', {
      query: 'EGFR', condition: 'lung cancer', intervention: 'lazertinib',
      phase: '3', status: 'Active, not recruiting', maxResults: 2,
    }, live);
    const [searchUrl, searchOptions] = fetchMock.mock.calls[0];
    const url = new URL(String(searchUrl));
    expect(url.origin + url.pathname).toBe('https://clinicaltrials.gov/api/v2/studies');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      'query.term': 'EGFR', 'query.cond': 'lung cancer', 'query.intr': 'lazertinib',
      'filter.advanced': 'AREA[Phase]PHASE3', 'filter.overallStatus': 'ACTIVE_NOT_RECRUITING', pageSize: '2',
    });
    expect(searchOptions?.signal).toBeInstanceOf(AbortSignal);
    expect(search).toMatchObject({ source: 'live', data: [{
      nctId: 'NCT04487080', title: 'A live trial', sponsor: 'Janssen', conditions: ['NSCLC'], interventions: ['Lazertinib'],
      primaryOutcomes: [{ measure: 'Progression-free survival', timeFrame: 'Up to 3 years' }],
    }] });
    expect(await registry.query('clinicaltrials', 'get_trial', { nctId: 'NCT04487080' }, live))
      .toMatchObject({ source: 'live', data: { nctId: 'NCT04487080' } });
    expect(String(fetchMock.mock.calls[1][0])).toBe('https://clinicaltrials.gov/api/v2/studies/NCT04487080');
    expect(await registry.query('clinicaltrials', 'get_trial', { nctId: 'NCT04487080' }, live))
      .toMatchObject({ source: 'offline-fallback', data: { acronym: 'MARIPOSA' } });
    await expect(registry.query('clinicaltrials', 'get_trial', { nctId: '../NCT04487080' }, live))
      .rejects.toThrow('Expected an NCT ID');
  });

  it('searches, sorts and spills OpenAlex fixtures and follows curated forward citations', async () => {
    const doi = '10.1038/s41586-021-03819-2';
    const work = await registry.query('openalex', 'get_work', { doi: 'https://doi.org/' + doi }, inline);
    expect(work).toMatchObject({ source: 'offline-fallback', data: {
      id: 'https://openalex.org/W3177828909', doi, pmid: '34265844', publicationYear: 2021, journal: 'Nature',
      citedByCount: expect.any(Number), openAccessUrl: expect.stringMatching(/^https:\/\//), authors: expect.arrayContaining(['John Jumper']),
    } });
    expect((await registry.query('openalex', 'get_work', { workId: 'w3177828909' }, inline)).data).toEqual(work.data);
    expect((await registry.query('openalex', 'cited_by', { doi, maxResults: 1 }, inline)).data)
      .toMatchObject([{ id: 'https://openalex.org/W3211795435' }]);
    const spilled = await registry.query('openalex', 'search_works', {
      query: 'AlphaFold', sort: 'publication_year:desc', maxResults: 1,
    }, { ...inline, maxBytes: 1 });
    expect(spilled).toMatchObject({ spilled: true, source: 'offline-fallback', spillHandle: { format: 'json' } });
    expect(JSON.parse(readFileSync(spilled.spillHandle!.filePath, 'utf8'))).toMatchObject([{ id: 'https://openalex.org/W3211795435' }]);
  });

  it('sets the OpenAlex search options and user agent and resolves a DOI before filtering citations', async () => {
    const doi = '10.1038/s41586-021-03819-2';
    const work = {
      id: 'https://openalex.org/W3177828909', doi: 'https://doi.org/' + doi,
      title: 'A live work', ids: { pmid: 'https://pubmed.ncbi.nlm.nih.gov/34265844' },
      publication_year: 2021, cited_by_count: 78, open_access: { oa_url: 'https://example.org/open' },
      authorships: [{ author: { display_name: 'John Jumper' } }], primary_location: { source: { display_name: 'Nature' } },
    };
    const citing = { id: 'https://openalex.org/W3211795435', display_name: 'A citing work' };
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(Response.json({ results: [work] }))
      .mockResolvedValueOnce(Response.json(work))
      .mockResolvedValueOnce(Response.json(work))
      .mockResolvedValueOnce(Response.json({ results: [citing] }))
      .mockResolvedValueOnce(Response.json({ results: [citing] }))
      .mockResolvedValueOnce(Response.json({ error: 'Upstream error' }));
    const live = { ...inline, allowLive: true };
    expect(await registry.query('openalex', 'search_works', { query: 'protein structure', sort: 'cited_by_count:desc', maxResults: 3 }, live))
      .toMatchObject({ source: 'live', data: [{
        title: 'A live work', doi, pmid: '34265844', citedByCount: 78, publicationYear: 2021,
        authors: ['John Jumper'], journal: 'Nature', openAccessUrl: 'https://example.org/open',
      }] });
    expect((await registry.query('openalex', 'get_work', { workId: work.id }, live)).data).toMatchObject({ id: work.id });
    expect(await registry.query('openalex', 'cited_by', { doi, maxResults: 4 }, live))
      .toMatchObject({ source: 'live', data: [{ id: citing.id, title: citing.display_name }] });
    expect((await registry.query('openalex', 'cited_by', { workId: 'W3177828909' }, live)).source).toBe('live');
    expect(await registry.query('openalex', 'search_works', { query: 'AlphaFold' }, live))
      .toMatchObject({ source: 'offline-fallback', data: expect.arrayContaining([expect.objectContaining({ doi })]) });
    const requests = fetchMock.mock.calls.map(([url, options]) => {
      expect(new Headers(options?.headers).get('User-Agent')).toBe('SciDeveloper/0.5');
      return new URL(String(url));
    });
    expect(requests.map(url => url.origin)).toEqual(Array(6).fill('https://api.openalex.org'));
    expect(requests.slice(0, 5).map(url => url.pathname)).toEqual([
      '/works', '/works/W3177828909', '/works/doi:' + doi, '/works', '/works',
    ]);
    expect(Object.fromEntries(requests[0].searchParams)).toEqual({ search: 'protein structure', sort: 'cited_by_count:desc', 'per-page': '3' });
    expect(Object.fromEntries(requests[3].searchParams)).toEqual({ filter: 'cites:W3177828909', 'per-page': '4' });
    expect(requests[4].searchParams.get('filter')).toBe('cites:W3177828909');
  });

  it('reads searchable Zotero fixtures with collection memberships and notes while offline', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const search = await registry.query('zotero', 'search_items', { query: 'egfr', collectionKey: 'egfrtrls', maxResults: 1 }, inline);
    expect(search).toMatchObject({ source: 'offline-fallback', data: [{
      key: 'FLAURA22', doi: '10.1056/NEJMoa2306434', authors: expect.arrayContaining(['David Planchard']),
      tags: expect.arrayContaining(['EGFR']), collections: ['EGFRTRLS'], notes: [expect.stringContaining('FLAURA2')],
    }] });
    expect((await registry.query('zotero', 'get_item', { itemKey: 'flaura22' }, inline)).data).toEqual((search.data as unknown[])[0]);
    expect((await registry.query('zotero', 'list_collections', {}, inline)).data)
      .toEqual(expect.arrayContaining([expect.objectContaining({ key: 'EGFRTRLS', parentCollection: 'THRXTRLS' })]));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('routes Zotero cloud reads with API key headers for both credential formats', async () => {
    let token = 'cloud-key';
    const credentials = new ConnectorRegistry({ spillDir, credentialResolver: id => id === 'zotero' ? token : null });
    expect(credentials.listConnectors().find(entry => entry.id === 'zotero')).toMatchObject({
      supportsCredential: true, hasCredential: true,
      credentialLabel: 'Zotero API Key (or leave blank for local Desktop API :23119)',
    });
    const item = { key: 'ABCD2345', data: {
      title: 'A cloud article', itemType: 'journalArticle', DOI: '10.1234/demo', creators: [
        { firstName: 'Ada', lastName: 'Lovelace', creatorType: 'author' },
        { name: 'An editor', creatorType: 'editor' },
      ], collections: ['EGFRTRLS'], tags: [{ tag: 'genomics' }],
    } };
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(Response.json([item]))
      .mockResolvedValueOnce(Response.json(item))
      .mockResolvedValueOnce(Response.json([{ key: 'EGFRTRLS', data: { name: 'Trials', parentCollection: false } }]));
    const live = { ...inline, allowLive: true };
    expect(await credentials.query('zotero', 'search_items', {
      query: 'genomics', userId: 42, collectionKey: 'EGFRTRLS', maxResults: 3,
    }, live)).toMatchObject({ source: 'live', data: [{ key: item.key, doi: '10.1234/demo', tags: ['genomics'], authors: ['Ada Lovelace'] }] });
    token = '42:compound-key';
    expect(await credentials.query('zotero', 'get_item', { itemKey: item.key }, live))
      .toMatchObject({ source: 'live', data: { key: item.key, title: item.data.title } });
    expect(await credentials.query('zotero', 'list_collections', {}, live))
      .toMatchObject({ source: 'live', data: [{ key: 'EGFRTRLS', name: 'Trials', parentCollection: null }] });
    const urls = fetchMock.mock.calls.map(([url, options], index) => {
      const parsed = new URL(String(url));
      expect(parsed.origin).toBe('https://api.zotero.org');
      expect(parsed.searchParams.has('key')).toBe(false);
      const headers = new Headers(options?.headers);
      expect(headers.get('Zotero-API-Version')).toBe('3');
      expect(headers.get('Zotero-API-Key')).toBe(index === 0 ? 'cloud-key' : 'compound-key');
      return parsed;
    });
    expect(urls.map(url => url.pathname)).toEqual(['/users/42/collections/EGFRTRLS/items', '/users/42/items/ABCD2345', '/users/42/collections']);
    expect(Object.fromEntries(urls[0].searchParams)).toEqual({ q: 'genomics', qmode: 'everything', limit: '3' });
  });

  it('uses the Zotero desktop API when selected or unconfigured and falls back if unreachable', async () => {
    const credentials = new ConnectorRegistry({ spillDir, credentialResolver: () => '42:private-key' });
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(Response.json([]))
      .mockResolvedValueOnce(Response.json({ key: 'ABCD2345', data: {
        itemType: 'note', parentItem: 'FLAURA22', note: '<p>Local literature note</p>',
      } }))
      .mockRejectedValueOnce(new TypeError('connection refused'));
    const live = { ...inline, allowLive: true };
    expect(await registry.query('zotero', 'search_items', {}, live)).toMatchObject({ source: 'live', data: [] });
    expect(await credentials.query('zotero', 'get_item', { itemKey: 'ABCD2345', local: true }, live))
      .toMatchObject({ source: 'live', data: { parentItem: 'FLAURA22', notes: ['<p>Local literature note</p>'] } });
    expect(await registry.query('zotero', 'list_collections', {}, live))
      .toMatchObject({ source: 'offline-fallback', data: expect.arrayContaining([expect.objectContaining({ key: 'EGFRTRLS' })]) });
    expect(timeout.mock.calls.filter(([ms]) => ms === 1500)).toHaveLength(3);
    expect(fetchMock.mock.calls.map(([url, options]) => {
      expect(new Headers(options?.headers).has('Zotero-API-Key')).toBe(false);
      expect(options?.signal).toBeInstanceOf(AbortSignal);
      const parsed = new URL(String(url));
      return parsed.origin + parsed.pathname;
    })).toEqual(['/items', '/items/ABCD2345', '/collections'].map(path => 'http://127.0.0.1:23119/api/users/0' + path));
  });

  it('lists every page of Zotero collections in a selected group', async () => {
    const credentials = new ConnectorRegistry({ spillDir, credentialResolver: () => 'group-key' });
    const page = (key: string, name: string) => Response.json([{ key, data: { name } }], { headers: { 'Total-Results': '2' } });
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(page('ABCD2345', 'First page'))
      .mockResolvedValueOnce(page('EFGH2345', 'Second page'));
    expect(await credentials.query('zotero', 'list_collections', { groupId: 34 }, { ...inline, allowLive: true }))
      .toMatchObject({ source: 'live', data: [{ name: 'First page' }, { name: 'Second page' }] });
    const urls = fetchMock.mock.calls.map(([url, options]) => {
      expect(new Headers(options?.headers).get('Zotero-API-Key')).toBe('group-key');
      return new URL(String(url));
    });
    expect(urls.map(url => url.origin + url.pathname)).toEqual(Array(2).fill('https://api.zotero.org/groups/34/collections'));
    expect(urls.map(url => url.searchParams.get('start'))).toEqual(['0', '1']);
  });
});

describe('Connector credentials', () => {
  it('reports credential support and reflects credential changes without exposing secret values', () => {
    const credentials = new Map([['pubmed', 'private-key'], ['research-mcp', 'private-token']]);
    const registry = new ConnectorRegistry({ spillDir, credentialResolver: id => credentials.get(id) ?? null });
    registry.registerExternalServer({
      id: 'research-mcp', name: 'Research MCP', enabled: true, transport: 'http', url: 'https://mcp.example.test',
    });
    const info = (id: string) => registry.listConnectors().find(item => item.id === id);
    expect(info('pubmed')).toMatchObject({ supportsCredential: true, hasCredential: true,
      credentialLabel: 'NCBI API Key (higher rate limits)' });
    for (const id of ['clinvar', 'geo']) {
      expect(info(id)).toMatchObject({ supportsCredential: true, hasCredential: false,
        credentialLabel: 'NCBI API Key (higher rate limits)' });
    }
    expect(info('eln-benchling')).toMatchObject({ supportsCredential: true, hasCredential: false,
      credentialLabel: 'ELN / Benchling API Token' });
    expect(info('cbioportal')).toMatchObject({ supportsCredential: true, hasCredential: false,
      credentialLabel: 'cBioPortal Auth Token' });
    expect(info('research-mcp')).toMatchObject({ supportsCredential: true, hasCredential: true });
    expect(info('uniprot')?.supportsCredential).toBeUndefined();
    expect(JSON.stringify(registry.listConnectors())).not.toContain('private-');
    credentials.delete('pubmed');
    credentials.set('eln-benchling', 'rotated-token');
    expect(info('pubmed')?.hasCredential).toBe(false);
    expect(info('eln-benchling')?.hasCredential).toBe(true);
  });

  it('adds each NCBI key to search and retrieval requests and keeps it out of Europe PMC', async () => {
    const keys: Record<string, string> = { pubmed: 'pubmed+/key', clinvar: 'variant-key', geo: 'series-key' };
    const registry = new ConnectorRegistry({ spillDir, credentialResolver: id => keys[id] ?? null });
    const requests: URL[] = [];
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = new URL(String(input));
      requests.push(url);
      if (url.hostname !== 'eutils.ncbi.nlm.nih.gov') return new Response(null, { status: 503 });
      const db = url.searchParams.get('db');
      if (url.pathname.endsWith('/esearch.fcgi')) return Response.json({ esearchresult: { idlist: ['123'] } });
      if (db === 'pubmed') return new Response('PMID- 123\nTI  - Synthetic article\nAB  - Example abstract\n');
      const record = db === 'clinvar'
        ? { uid: '123', accession: 'VCV000000123', title: 'Synthetic variant' }
        : { accession: 'GSE123', title: 'Synthetic series' };
      return Response.json({ result: { uids: ['123'], 123: record } });
    });
    const live = { allowLive: true };
    await expect(registry.query('pubmed', 'search', { query: 'test' }, live))
      .resolves.toMatchObject({ source: 'live', data: [{ pmid: '123' }] });
    await expect(registry.verifyCitation('123', live)).resolves.toMatchObject({ verified: true, source: 'live' });
    await expect(registry.query('clinvar', 'search_variants', { query: 'test' }, live))
      .resolves.toMatchObject({ source: 'live', data: [{ variationId: '123' }] });
    await expect(registry.query('geo', 'fetch_series', { accession: 'GSE123' }, live))
      .resolves.toMatchObject({ source: 'live', data: { accession: 'GSE123' } });
    expect(requests.filter(url => url.hostname === 'eutils.ncbi.nlm.nih.gov')
      .map(url => [url.pathname.split('/').at(-1), url.searchParams.get('api_key')])).toEqual([
      ['esearch.fcgi', keys.pubmed], ['efetch.fcgi', keys.pubmed], ['efetch.fcgi', keys.pubmed],
      ['esearch.fcgi', keys.clinvar], ['esummary.fcgi', keys.clinvar],
      ['esearch.fcgi', keys.geo], ['esummary.fcgi', keys.geo],
    ]);
    expect(requests.filter(url => url.hostname === 'www.ebi.ac.uk')).toHaveLength(2);
    expect(requests.filter(url => url.hostname === 'www.ebi.ac.uk').every(url => !url.searchParams.has('api_key'))).toBe(true);
    fetch.mockClear();
    await expect(registry.query('pubmed', 'search', {}, offline)).resolves.toMatchObject({ source: 'offline-fallback' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('uses resolved bearer tokens for ELN and cBioPortal requests', async () => {
    vi.stubEnv('SCIDEV_ELN_URL', 'https://lab.example.test/v1');
    vi.stubEnv('SCIDEV_ELN_TOKEN', 'environment-token');
    const registry = new ConnectorRegistry({ spillDir,
      credentialResolver: id => ({ 'eln-benchling': 'lab-token', cbioportal: 'portal-token' })[id] ?? null });
    const fetch = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(Response.json([{ id: 'exp-live' }]))
      .mockResolvedValueOnce(Response.json({ id: 'protocol-live' }))
      .mockResolvedValueOnce(Response.json({ id: 'sample-live' }))
      .mockResolvedValueOnce(Response.json([]));
    const live = { allowLive: true };
    await expect(registry.query('eln-benchling', 'list_experiments', {}, live)).resolves.toMatchObject({ source: 'live' });
    await expect(registry.query('eln-benchling', 'fetch_protocol', { id: 'protocol-live' }, live))
      .resolves.toMatchObject({ source: 'live' });
    await expect(registry.query('eln-benchling', 'register_sample', { name: 'Control', type: 'RNA', experiment: 'exp-live' }, live))
      .resolves.toMatchObject({ source: 'live' });
    await expect(registry.query('cbioportal', 'list_studies', {}, live)).resolves.toMatchObject({ source: 'live' });
    expect(fetch.mock.calls.map(([, init]) => new Headers(init?.headers).get('Authorization')))
      .toEqual(['Bearer lab-token', 'Bearer lab-token', 'Bearer lab-token', 'Bearer portal-token']);
  });

  it('authenticates external MCP tool discovery and calls while preserving configured authorization', async () => {
    const registry = new ConnectorRegistry({ spillDir, credentialResolver: () => 'resolved-token' });
    const server = { id: 'test-mcp', name: 'Test MCP', transport: 'http' as const, enabled: true,
      url: 'https://mcp.example.test' };
    registry.registerExternalServer(server);
    registry.registerExternalServer({ ...server, id: 'manual', headers: { authorization: 'Basic configured' } });
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, options) => {
      const { id, method } = JSON.parse(String(options?.body));
      if (method === 'notifications/initialized') return new Response(null, { status: 202 });
      const result = method === 'initialize' ? { protocolVersion: '2024-11-05' }
        : method === 'tools/list' ? { tools: [{ name: 'echo' }] } : { structuredContent: { ok: true } };
      return Response.json({ jsonrpc: '2.0', id, result });
    });
    await expect(registry.discoverExternalTools(server.id)).resolves.toEqual([{ name: 'echo' }]);
    await expect(registry.query(server.id, 'echo', {})).resolves.toMatchObject({ data: { ok: true } });
    await expect(registry.query('manual', 'echo', {})).resolves.toMatchObject({ data: { ok: true } });
    expect(fetch.mock.calls.map(([, init]) => new Headers(init?.headers).get('Authorization')))
      .toEqual([...Array(6).fill('Bearer resolved-token'), ...Array(3).fill('Basic configured')]);
    expect(registry.listExternalServers()[0]).toEqual(server);
  });
});

describe('External MCP servers', () => {
  it('loads persisted servers, rejects disabled servers and removes a server', async () => {
    const config = { id: 'disabled', name: 'Disabled MCP', enabled: false, transport: 'stdio' as const };
    const restored = new ConnectorRegistry({ spillDir, initialExternalServers: [config] });
    expect(restored.listExternalServers()).toEqual([config]);
    await expect(restored.discoverExternalTools('disabled')).rejects.toThrow('is disabled');
    await expect(restored.query('disabled', 'echo', {})).rejects.toThrow('is disabled');
    expect(restored.removeExternalServer('disabled')).toBe(true);
    expect(restored.removeExternalServer('disabled')).toBe(false);
    await expect(restored.discoverExternalTools('disabled')).rejects.toThrow('Unknown external MCP server');
    const broken = { ...config, id: 'broken', enabled: true };
    restored.registerExternalServer(broken);
    await expect(restored.discoverExternalTools('broken')).rejects.toThrow('requires a command');
    expect(restored.listConnectors()).toContainEqual(expect.objectContaining({ id: 'broken', status: 'error' }));
  });

  it('discovers a real stdio MCP server and spills large tool results', async () => {
    const script = `
      const assert = require('node:assert/strict');
      const lines = require('node:readline').createInterface({ input: process.stdin });
      const tools = ['echo', 'large'].map(name => ({ name, description: 'Science helper', inputSchema: { type: 'object' } }));
      let state = 'new';
      lines.on('line', line => {
        const { id, jsonrpc, method, params } = JSON.parse(line);
        assert.equal(jsonrpc, '2.0');
        const send = result => console.log(JSON.stringify({ jsonrpc: '2.0', id, result }));
        if (method === 'initialize') {
          assert.equal(state, 'new');
          assert.deepEqual(params, { protocolVersion: '2024-11-05', capabilities: {},
            clientInfo: { name: 'scideveloper', version: '0.2.0' } });
          state = 'initializing';
          send({ protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'science', version: '1' } });
          return;
        }
        if (method === 'notifications/initialized') {
          assert.equal(state, 'initializing');
          assert.equal(id, undefined);
          state = 'ready';
          return;
        }
        assert.equal(state, 'ready');
        if (method === 'tools/list') {
          send(params?.cursor === 'next' ? { tools: [tools[1]] } : { tools: [tools[0]], nextCursor: 'next' });
        } else if (method === 'tools/call') {
          const payload = params.name === 'large'
            ? Array.from({ length: 512 }, (_, index) => ({ index, gene: params.arguments.gene }))
            : { ...params.arguments, unit: process.env.SCI_TEST_UNIT, pid: process.pid };
          send({ content: [{ type: 'text', text: JSON.stringify(payload) }] });
        } else {
          assert.fail(method);
        }
      });
    `;
    registry.registerExternalServer({ id: 'science', name: 'Science MCP', transport: 'stdio', enabled: true,
      command: process.execPath, args: ['-e', script], env: { SCI_TEST_UNIT: 'nM' } });
    const tools = await registry.discoverExternalTools('science');
    expect(tools.map(tool => tool.name)).toEqual(['echo', 'large']);
    expect(registry.listConnectors()).toContainEqual(expect.objectContaining({ id: 'science', status: 'connected',
      operations: ['echo', 'large'], discoveredTools: tools }));
    tools[0].name = 'modified';
    expect(registry.listConnectors().find(connector => connector.id === 'science')?.operations).toEqual(['echo', 'large']);

    const echo = await registry.query('science', 'echo', { gene: 'TP53' });
    expect(echo).toMatchObject({ source: 'live', spilled: false, data: { gene: 'TP53', unit: 'nM', pid: expect.any(Number) } });
    expect(() => process.kill((echo.data as { pid: number }).pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
    const large = await registry.query('science', 'large', { gene: 'EGFR' });
    expect(large).toMatchObject({ source: 'live', spilled: true, spillHandle: { format: 'json', lineCount: expect.any(Number) } });
    expect(large.data).toBeUndefined();
    const payload: unknown = JSON.parse(readFileSync(large.spillHandle!.filePath, 'utf8'));
    expect(payload).toEqual(Array.from({ length: 512 }, (_, index) => ({ index, gene: 'EGFR' })));
  }, 15_000);

  it('uses HTTP JSON, streaming SSE, session headers and protocol errors', async () => {
    const requests: string[] = [];
    let cancelled = false;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      expect(String(input)).toBe('https://lab.example/mcp');
      const headers = new Headers(init?.headers);
      expect(headers.get('authorization')).toBe('Bearer test-token');
      expect(headers.get('content-type')).toBe('application/json');
      expect(headers.get('accept')).toBe('application/json, text/event-stream');
      if (init?.method === 'DELETE') {
        expect(headers.get('mcp-session-id')).toBe('session');
        requests.push('DELETE');
        return new Response(null, { status: 204 });
      }
      expect(init?.method).toBe('POST');
      const { id, method, params } = JSON.parse(String(init?.body));
      requests.push(method);
      const reply = (result: unknown) => ({ jsonrpc: '2.0', id, result });
      if (method === 'initialize') {
        expect(params.protocolVersion).toBe('2024-11-05');
        return Response.json(reply({ protocolVersion: '2025-03-26' }), { headers: { 'Mcp-Session-Id': 'session' } });
      }
      expect(headers.get('mcp-session-id')).toBe('session');
      expect(headers.get('mcp-protocol-version')).toBe('2025-03-26');
      if (method === 'notifications/initialized') {
        expect(id).toBeUndefined();
        return new Response(null, { status: 202 });
      }
      if (params.name === 'missing') return Response.json({ jsonrpc: '2.0', id, error: { code: -32602, message: 'Unknown tool' } });
      if (params.name === 'failing') return Response.json(reply({ isError: true, content: [{ type: 'text', text: 'Tool failed' }] }));
      const payload = reply({ structuredContent: params.arguments, content: [{ type: 'text', text: 'fallback' }] });
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(`: keepalive\r\nevent: message\r\ndata: {"jsonrpc":"2.0","method":"notifications/message"}\r\n\r\ndata: {\r`));
          controller.enqueue(encoder.encode(`\ndata: ${JSON.stringify(payload).slice(1)}\r\n\r\n`));
        },
        cancel() { cancelled = true; },
      });
      return new Response(stream, { headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
    });
    const config = { id: 'lab', name: 'Lab', enabled: true, transport: 'http' as const, url: 'https://lab.example/mcp',
      headers: { authorization: 'Bearer test-token' } };
    await expect(callExternalMcpTool(config, 'echo', { gene: 'β' })).resolves.toEqual({ gene: 'β' });
    expect(cancelled).toBe(true);
    expect(requests).toEqual(['initialize', 'notifications/initialized', 'tools/call', 'DELETE']);
    await expect(callExternalMcpTool(config, 'missing', {})).rejects.toThrow('MCP JSON-RPC error -32602: Unknown tool');
    await expect(callExternalMcpTool(config, 'failing', {})).rejects.toThrow('failed: Tool failed');
  });
});
