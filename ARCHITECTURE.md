# SciDeveloper — Master Architecture & Engineering Specification

**SciDeveloper** is a local-first AI Scientific Research Workbench modeled after the core architecture and engineering methodology of Claude Science.

## 1. Core Architectural Pillars

1. **Multi-Agent Hierarchy + Independent Background Reviewer Loop** (`@scideveloper/agents`)
   - **Coordinator Agent**: Decomposes scientific goals, discovers skills progressively, delegates isolated tasks to domain specialists, and synthesizes publication-ready findings.
   - **Specialist Sub-Agents**: Context-isolated domain experts (`genomics`, `structural-biology`, `cheminformatics`, `statistics`, `manuscript`, plus custom user specialists).
   - **Background Reviewer Agent**: Asynchronously audits every artifact & analytical claim for:
     - *Code-to-Figure / Numeric Parity* (prose numbers match computed script outputs & tables),
     - *Statistical Rigor* (sample size, multiple testing correction, effect size, missing values),
     - *Citation Cross-Verification* (PMIDs/DOIs verified against literature connector outputs).
2. **DAG Session Tree & 4-Layer Provenance Engine** (`@scideveloper/provenance`)
   - SQLite-backed (`node:sqlite`) tree/DAG state model where every message, tool execution, and sub-agent run is a node with a `parentId`.
   - **Session Forking**: Fork a new research branch from any historical node without mutating the primary audit trail.
   - **4-Layer Provenance Manifest** attached to every generated artifact:
     1. `executionCode`: Exact versioned script/command that produced the artifact + SHA-256 hash.
     2. `environmentSnapshot`: Runtime versions (Python/R/Node), key installed packages, OS/compute target metadata.
     3. `conversationalLineage`: Ordered chain of node IDs, prompts, and sub-agent delegations from root to artifact.
     4. `plainLanguageSummary`: Human-readable Methods summary ready for manuscripts & supplementary materials.
   - **Reproducibility Bundle Export**: Exports a self-contained directory/JSON+script+methods bundle for independent reproduction.
3. **Heterogeneous Compute & Local-First Privacy** (`@scideveloper/compute`)
   - **Permission-Gated I/O**: Declarative policy (`allow` / `ask` / `deny`) gating filesystem boundaries, external scientific APIs, local execution, and remote SSH/HPC dispatch, with interactive approval workflow.
   - **Local Persistent Python 3 Sandbox**: Long-lived Python worker bound to the session workspace (captures stdout/stderr, matplotlib/SVG/PNG figures, CSV/JSON tables, and environment snapshots without uploading raw datasets to the cloud). Optional Rscript runner when R is available.
   - **Remote SSH & HPC Slurm Adapter**: Generates `sbatch` scripts (partition, GPUs, CPUs, memory, walltime, conda/modules), supports SSH dispatch or local simulation mode, and tracks job lifecycle (`queued` / `running` / `completed` / `failed`).
4. **Progressive Disclosure Skills Engine** (`@scideveloper/skills`)
   - Scans `skills/*/SKILL.md` (YAML frontmatter + markdown SOP + optional helper scripts).
   - **Phase 1 (Catalog)**: Injects only compact `{ name, description, domain, tags }` metadata into Coordinator context.
   - **Phase 2 (On-Demand Load)**: Full SOP body and helper scripts are loaded only when invoked via `load_skill`.
5. **MCP Scientific Connectors + Large-Result Spill-to-Disk** (`@scideveloper/mcp-connectors`)
   - Standard MCP connector interface + built-in scientific connectors (**PubMed/EuropePMC**, **RCSB PDB**, **UniProt**, **ChEMBL/PubChem**, **Ensembl/GEO**) with live HTTP + deterministic offline fallback.
   - External custom MCP server registry (stdio/HTTP config).
   - **Context Spill-to-Disk Middleware**: Payloads exceeding configurable byte/line limits are automatically written to `<sessionDir>/spills/<id>.<ext>` with SHA-256 hash, schema summary, and preview lines; only the compact handle is returned to the LLM.
6. **Decoupled Local Loopback Server + Desktop Shell + Scientific Workbench UI** (`apps/server`, `apps/desktop`, `apps/web`)
   - `apps/server`: Express + WebSocket/SSE loopback server (`http://127.0.0.1:4318`) serving all REST APIs, real-time agent/reviewer event streams, static artifact files, and built web assets.
   - `apps/desktop`: Electron Main Process + Preload (`contextBridge`) spawning/attaching to the loopback server with native file/folder dialogs.
   - `apps/web`: React + Vite + Tailwind Scientific Workbench with:
     - Interactive Session DAG Tree & One-Click Forking,
     - Multi-Agent Stream + Inline Permission Approvals + Spill-to-Disk Cards,
     - Native Scientific Renderers (**3D Protein PDB Viewer**, **2D Molecule Viewer**, **Genome Browser Track Viewer**, **Publication Figure & Data Table Viewer**, **Manuscript Viewer**),
     - 4-Layer Provenance Drawer & Reproducibility Bundle Export,
     - Live Background Reviewer Audit Panel,
     - Compute Target (Local Sandbox / SSH-Slurm HPC) & LLM Provider Settings.

## 2. Package Dependency Graph

```
@scideveloper/shared
  ├── @scideveloper/provenance
  ├── @scideveloper/skills
  ├── @scideveloper/mcp-connectors
  ├── @scideveloper/compute
  └── @scideveloper/agents (depends on shared, provenance, skills, mcp-connectors, compute)
        └── @scideveloper/server (depends on all packages)
              ├── @scideveloper/web (talks to server over HTTP/SSE/WS)
              └── @scideveloper/desktop (Electron shell hosting server + web)
```

## 3. REST & Streaming API Contract (`apps/server`)

- `GET /api/health` — System health, Python/R availability, active compute target, active LLM mode.
- `GET /api/sessions` — List sessions.
- `POST /api/sessions` — Create a new research session `{ title, workspacePath?, computeTargetId? }`.
- `GET /api/sessions/:id` — Get full session details, DAG nodes, artifacts, review reports, loaded skills.
- `POST /api/sessions/:id/fork` — Fork session from `{ fromNodeId, title? }`.
- `POST /api/sessions/:id/messages` — Submit research prompt `{ content, parentNodeId?, specialist?, computeTargetId? }` (runs Coordinator -> Specialists -> Reviewer asynchronously, broadcasting events over SSE/WS).
- `GET /api/sessions/:id/events` — Server-Sent Events (SSE) stream of `WorkbenchEvent`s for real-time UI updates.
- `GET /api/sessions/:id/artifacts/:artifactId/provenance` — Full 4-layer provenance manifest.
- `POST /api/sessions/:id/artifacts/:artifactId/export` — Export reproducibility bundle and return bundle manifest/files.
- `GET /api/sessions/:id/artifacts/:artifactId/content` — Serve raw artifact file (PNG/SVG/CSV/PDB/JSON/MD).
- `POST /api/sessions/:id/review` — Trigger or re-run Background Reviewer Agent on an artifact or session node.
- `GET /api/skills` — List progressive skill catalog (metadata + loaded status).
- `GET /api/skills/:name` — Load full skill SOP & scripts.
- `GET /api/connectors` — List MCP scientific connectors + status + custom MCP servers.
- `POST /api/connectors/:id/query` — Direct connector test query (goes through Spill-to-Disk middleware).
- `GET /api/compute/targets` — List Local Sandbox & SSH/Slurm HPC compute targets.
- `POST /api/compute/targets` — Add/update an SSH/Slurm HPC target.
- `POST /api/compute/slurm/preview` — Generate a Slurm `sbatch` script preview.
- `POST /api/compute/slurm/submit` — Submit a Slurm job (live SSH or dry-run simulator).
- `GET /api/compute/slurm/jobs` — List tracked Slurm jobs.
- `GET /api/permissions/policy` & `PUT /api/permissions/policy` — View/update declarative permission policy.
- `GET /api/permissions/pending` & `POST /api/permissions/:requestId/decide` — Approve or deny gated I/O operations.
- `GET /api/settings` & `PUT /api/settings` — Configure LLM provider (`demo` / `openai` / `anthropic` / `ollama`), model, baseUrl, API key (kept server-side, masked on read).
- `GET /api/demos` — Pre-built end-to-end scientific workflow templates.
