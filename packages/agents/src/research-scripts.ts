import fs from 'node:fs';
import path from 'node:path';

export const datasetExtensions = new Set(['.csv', '.tsv', '.json', '.pdb', '.xlsx', '.vcf', '.parquet']);

export function readTablePreview(filePath: string, delimiter: ',' | '\t') {
  const content = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
  const field = new RegExp(`(?:"((?:[^"]|"")*)"|([^${delimiter}\\r\\n]*))(${delimiter}|\\r\\n|\\r|\\n|$)`, 'y');
  const preview: string[][] = [];
  let totalRecords = 0;
  let row: string[] = [];
  while (field.lastIndex < content.length) {
    const match = field.exec(content);
    if (!match || !match[0]) break;
    const end = field.lastIndex === content.length;
    if (totalRecords < 31) row.push(match[1] === undefined ? match[2] : match[1].replaceAll('""', '"'));
    if (match[3] === delimiter && !end) continue;
    if (totalRecords < 31) preview.push(end && match[3] === delimiter ? [...row, ''] : row);
    totalRecords++;
    row = [];
  }
  const [headers = [], ...rows] = preview;
  return { headers, rows, totalRows: Math.max(0, totalRecords - 1) };
}

export function datasetAnalysisScript(relativePath: string): string {
  return `
import json
import os

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd

source = os.path.join(SCIDEV_WORKSPACE_DIR, ${JSON.stringify(relativePath)})
extension = os.path.splitext(source)[1].lower()

def read_excel_without_engine(filename):
    import posixpath
    from xml.etree import ElementTree as ET
    from zipfile import ZipFile

    with ZipFile(filename) as workbook:
        def xml(part):
            return ET.fromstring(workbook.read(part))

        def read_part(target):
            part = target.lstrip("/") if target.startswith("/") else posixpath.normpath(posixpath.join("xl", target))
            return xml(part)

        sheets = xml("xl/workbook.xml").findall(".//{*}sheet")
        if not sheets:
            return pd.DataFrame()
        relationships = xml("xl/_rels/workbook.xml.rels")
        sheet_id = next(value for key, value in sheets[0].attrib.items() if key.endswith("}id"))
        target = next(item.get("Target") for item in relationships if item.get("Id") == sheet_id)
        sheet = read_part(target)
        shared_strings = []
        for item in relationships:
            if item.get("Type", "").endswith("/sharedStrings"):
                shared_strings = ["".join(t.text or "" for t in node.findall(".//{*}t"))
                                  for node in read_part(item.get("Target"))]
                break

        rows = []
        width = 0
        for row in sheet.findall(".//{*}sheetData/{*}row"):
            values = {}
            for cell in row.findall("{*}c"):
                index = 0
                for letter in cell.get("r", ""):
                    if not ("A" <= letter <= "Z"):
                        break
                    index = index * 26 + ord(letter) - ord("A") + 1
                column = index - 1 if index else max(values, default=-1) + 1
                value = cell.findtext("{*}v")
                kind = cell.get("t", "n")
                if kind == "inlineStr":
                    value = "".join(t.text or "" for t in cell.findall("{*}is//{*}t"))
                elif value is not None:
                    if kind == "s":
                        value = shared_strings[int(value)]
                    elif kind == "n":
                        value = float(value)
                    elif kind == "b":
                        value = value == "1"
                    elif kind == "e":
                        value = None
                values[column] = value
            if values:
                rows.append(values)
                width = max(width, max(values) + 1)
        if not rows:
            return pd.DataFrame()
        headers = []
        used = set()
        for index in range(width):
            value = rows[0].get(index)
            name = str(value) if value is not None else f"Unnamed: {index}"
            candidate, duplicate = name, 0
            while candidate in used:
                duplicate += 1
                candidate = f"{name}.{duplicate}"
            used.add(candidate)
            headers.append(candidate)
        return pd.DataFrame([[row.get(index) for index in range(width)] for row in rows[1:]], columns=headers)

if extension in (".csv", ".tsv"):
    try:
        frame = pd.read_csv(source, sep="\\t" if extension == ".tsv" else ",", low_memory=False)
    except pd.errors.EmptyDataError:
        frame = pd.DataFrame()
elif extension == ".xlsx":
    try:
        frame = pd.read_excel(source)
    except ImportError:
        frame = read_excel_without_engine(source)
elif extension == ".vcf":
    with open(source, encoding="utf-8-sig") as handle:
        skipped = 0
        for line in handle:
            if not line.startswith("##"):
                break
            skipped += 1
        handle.seek(0)
        frame = pd.read_csv(handle, sep="\\t", skiprows=skipped, na_values=".", keep_default_na=False)
elif extension == ".parquet":
    frame = pd.read_parquet(source)
elif extension == ".json":
    with open(source, encoding="utf-8-sig") as handle:
        data = json.load(handle)
    if isinstance(data, dict) and isinstance(data.get("records"), list):
        data = data["records"]
    if isinstance(data, list) and all(isinstance(item, dict) for item in data):
        frame = pd.json_normalize(data)
    elif isinstance(data, dict) and data and all(isinstance(item, list) for item in data.values()) and len({len(item) for item in data.values()}) == 1:
        frame = pd.DataFrame(data)
    elif isinstance(data, dict):
        frame = pd.json_normalize([data])
    else:
        frame = pd.DataFrame({"value": data if isinstance(data, list) else [data]})
else:
    atoms = []
    def pdb_number(field):
        try:
            return float(field)
        except ValueError:
            return np.nan
    with open(source, encoding="utf-8", errors="replace") as handle:
        for line in handle:
            if line.startswith(("ATOM  ", "HETATM")):
                atoms.append({
                    "chain": line[21:22].strip() or None, "residue": line[17:20].strip() or None,
                    "x": pdb_number(line[30:38]), "y": pdb_number(line[38:46]), "z": pdb_number(line[46:54]),
                    "occupancy": pdb_number(line[54:60]), "b_factor": pdb_number(line[60:66]),
                })
    frame = pd.DataFrame(atoms, columns=["chain", "residue", "x", "y", "z", "occupancy", "b_factor"])

numeric = frame.select_dtypes(include="number").replace([np.inf, -np.inf], np.nan)
records = []
for column in frame.columns:
    values = numeric[column] if column in numeric else frame[column]
    record = {
        "column": column, "dtype": str(frame[column].dtype),
        "non_missing": int(values.count()), "missing": int(values.isna().sum()),
    }
    if column in numeric and values.count():
        record.update(mean=values.mean(), std=values.std(), min=values.min(),
                      median=values.median(), max=values.max())
    records.append(record)
pd.DataFrame(records, columns=["column", "dtype", "non_missing", "missing", "mean", "std", "min", "median", "max"]).to_csv(
    os.path.join(SCIDEV_OUTPUT_DIR, "dataset_summary_statistics.csv"), index=False
)

variable_columns = [column for column in numeric if numeric[column].notna().any()]
with plt.style.context("default"):
    fig, axes = plt.subplots(1, 2, figsize=(10, 4.6), constrained_layout=True)
    fig.suptitle(os.path.basename(source))
    if variable_columns:
        column = variable_columns[0]
        axes[0].hist(numeric[column].dropna(), bins="auto", color="#0072b2", edgecolor="white")
        axes[0].set(title="Numeric distribution", xlabel=str(column), ylabel="Count")
    else:
        counts = frame.count().sort_values(ascending=False).head(12)
        axes[0].barh([str(column) for column in counts.index], counts.values, color="#0072b2")
        axes[0].set(title="Observed values by column", xlabel="Count")
    correlation_columns = [column for column in variable_columns if numeric[column].nunique() > 1][:8]
    if len(correlation_columns) > 1:
        correlation = numeric[correlation_columns].corr(method="pearson", min_periods=2)
        heatmap = axes[1].imshow(correlation, cmap="RdBu_r", vmin=-1, vmax=1)
        axes[1].set_xticks(range(len(correlation_columns)), correlation_columns, rotation=45, ha="right")
        axes[1].set_yticks(range(len(correlation_columns)), correlation_columns)
        axes[1].set_title("Pairwise Pearson correlation")
        fig.colorbar(heatmap, ax=axes[1], shrink=0.75)
    else:
        missing = pd.Series([item["missing"] for item in records], index=frame.columns, dtype=int)
        missing = missing.sort_values(ascending=False).head(12)
        axes[1].barh([str(column) for column in missing.index], missing.values, color="#d55e00")
        axes[1].set(title="Missing values by column", xlabel="Count")

SCIDEV_METRICS = {
    "rows": int(len(frame)), "columns": int(len(frame.columns)),
    "missing_values": sum(item["missing"] for item in records),
    "numeric_columns": int(len(numeric.columns)),
}
print("Dataset profile:", SCIDEV_METRICS)
`.trim();
}

const palettes = {
  colorblind: ['#0072b2', '#d55e00', '#009e73', '#cc79a7', '#e69f00', '#56b4e9', '#f0e442'],
  nature: ['#3c5488', '#e64b35', '#00a087', '#4dbbd5', '#f39b7f', '#8491b4', '#91d1c2'],
};

export function refinePlotScript(original: string, instruction: string): string {
  const dark = /\bdark\b/i.test(instruction) && !/\b(?:no|remove|disable) dark\b/i.test(instruction);
  const light = /\b(?:light|white) (?:theme|background)\b/i.test(instruction);
  const natureStyle = /\bnature\b/i.test(instruction);
  const palette = /colou?r[ -]?blind|okabe|accessible palette/i.test(instruction) ? palettes.colorblind :
    natureStyle ? palettes.nature : null;
  const size = /\b(\d{1,2}(?:\.\d+)?)\s*(?:pt|points?)(?:\b|$)|\bfont(?:\s+size)?\s*(?:=|to|of|:)\s*(\d{1,2}(?:\.\d+)?)/i.exec(instruction);
  const fontSize = size ? Math.max(5, Math.min(48, Number(size[1] ?? size[2]))) :
    /(?:larger|bigger|increase|enlarge).*?(?:font|text|label)/i.test(instruction) ? 14 :
      /(?:smaller|reduce).*?(?:font|text|label)/i.test(instruction) ? 9 : null;
  const title = (/\btitle\s*(?:(?:to|as)\s+|[:=]\s*)?["“]([^"”]+)["”]/i.exec(instruction)?.[1] ??
    /\btitle\s*(?:(?:to|as)\s+|[:=]\s*)?'([^']+)'/i.exec(instruction)?.[1] ??
    /\btitle\s*(?:(?:to|as)\s+|[:=]\s*)([^\n]+?)(?:\s+and\s+|$)/i.exec(instruction)?.[1])?.trim();
  const dpi = /\b(\d{2,4})\s*dpi\b|\bdpi\s*(?:=|to|of|:)\s*(\d{2,4})/i.exec(instruction);
  const gridOff = /(?:remove|hide|disable|no|without|turn off).*?\bgrid|\bgrid\s+off/i.test(instruction);
  const gridOn = /(?:show|add|enable|turn on).*?\bgrid|\bgrid\s+on/i.test(instruction);
  const options = {
    theme: dark ? 'dark' : light ? 'light' : null, natureStyle, palette, fontSize, title: title || null,
    dpi: dpi ? Math.max(72, Math.min(600, Number(dpi[1] ?? dpi[2]))) : null,
    grid: gridOff ? false : gridOn ? true : null,
  };

  // Keep prior refinements in the recorded script so successive refinements compose.
  return `${original}

def _scidev_refine_plots():
    import json
    import matplotlib.pyplot as plt
    from matplotlib.colors import to_hex, to_rgba
    from matplotlib.patches import Rectangle
    from matplotlib.text import Text

    options = json.loads(${JSON.stringify(JSON.stringify(options))})
    for figure_number in plt.get_fignums():
        figure = plt.figure(figure_number)
        theme = options["theme"]
        if theme:
            background, axes_background, foreground = (
                ("#111827", "#172033", "#f8fafc") if theme == "dark" else ("white", "white", "#172033")
            )
            figure.set_facecolor(background)
            for element in figure.findobj(Text):
                element.set_color(foreground)
        if options["title"]:
            figure.suptitle(options["title"], color=foreground if theme else None)
        if options["fontSize"]:
            for element in figure.findobj(Text):
                element.set_fontsize(options["fontSize"])
        color_map = {}
        def recolor(value):
            try:
                rgba = to_rgba(value)
            except (ValueError, TypeError):
                return value
            if rgba[3] == 0:
                return value
            key = to_hex(rgba)
            palette = options["palette"]
            if key not in color_map:
                color_map[key] = palette[len(color_map) % len(palette)]
            return to_rgba(color_map[key], rgba[3])
        for ax in figure.axes:
            if theme:
                ax.set_facecolor(axes_background)
                ax.tick_params(colors=foreground)
                for spine in ax.spines.values():
                    spine.set_color(foreground)
            if options["natureStyle"]:
                for side in ("top", "right"):
                    ax.spines[side].set_visible(False)
                ax.tick_params(direction="out", width=0.8)
            if options["grid"] is not None:
                ax.grid(options["grid"])
            if options["palette"]:
                for line in ax.lines:
                    line.set_color(recolor(line.get_color()))
                for patch in ax.patches:
                    if isinstance(patch, Rectangle):
                        patch.set_facecolor(recolor(patch.get_facecolor()))
                for collection in ax.collections:
                    faces = collection.get_facecolors()
                    if collection.get_array() is None and len(faces):
                        collection.set_facecolors([recolor(face) for face in faces])
        if options["dpi"]:
            savefig = getattr(figure, "_scidev_original_savefig", figure.savefig)
            figure._scidev_original_savefig = savefig
            def save_at_dpi(*args, save=savefig, resolution=options["dpi"], **kwargs):
                kwargs["dpi"] = resolution
                return save(*args, **kwargs)
            figure.savefig = save_at_dpi

_scidev_refine_plots()
_scidev_refinement_instruction = ${JSON.stringify(instruction)}
`.trim();
}

export function cleanPythonResponse(response: string): string {
  const fenced = /```(?:python|py)?[ \t]*\r?\n([\s\S]*?)```/i.exec(response);
  return (fenced?.[1] ?? response).trim();
}

export function datasetMethods(relativePath: string): string {
  const isPdb = path.extname(relativePath).toLowerCase() === '.pdb';
  const ingestion = isPdb ? 'Parsed fixed-width ATOM and HETATM records from the PDB coordinate file.' :
    'Read the workspace file into a pandas data frame using its file format.';
  return `Analyzed ${relativePath}. ${ingestion} Tabulated row and column counts, missing values, and descriptive statistics. Visualized the first numeric distribution and pairwise Pearson correlations where estimable, with count and missingness plots for other inputs.`;
}
