"""Collect the standard artifacts emitted by a Python cell."""

import json
import os
import stat
import sys
import time
import traceback
from pathlib import Path


def output_files(output_dir):
    files = {}
    for file in Path(output_dir).iterdir():
        try:
            info = file.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISREG(info.st_mode):
            files[file.name] = (info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)
    return files


def export_figures(output_dir, pyplot):
    figures = []
    failed = False
    if pyplot is None:
        return figures, failed
    try:
        stamp = time.time_ns()
        for index, number in enumerate(pyplot.get_fignums()):
            figure = pyplot.figure(number)
            bundle = {}
            for extension in ("png", "svg", "pdf"):
                file = os.path.join(output_dir, f"figure_{stamp}_{index}.{extension}")
                try:
                    figure.savefig(file, dpi=180, bbox_inches="tight")
                except Exception:
                    failed = True
                    traceback.print_exc()
                else:
                    bundle[f"{extension}Path"] = file
            if "pngPath" in bundle:
                figures.append(bundle)
    finally:
        pyplot.close("all")
    return figures, failed


def chart_metadata(file, spec):
    layout = spec.get("layout")
    layout_title = layout.get("title") if isinstance(layout, dict) else None
    if isinstance(layout_title, dict):
        layout_title = layout_title.get("text")
    title = spec.get("title") or layout_title
    chart = {
        "filePath": str(file),
        "title": title if isinstance(title, str) and title.strip() else file.name.removesuffix(".plotly.json"),
    }
    if isinstance(spec.get("description"), str):
        chart["description"] = spec["description"]
    return chart


def capture_plotly(output_dir, before, charts):
    captured = []
    generated = set()
    failed = False
    if isinstance(charts, list) and charts:
        encoder = None
        try:
            from plotly.utils import PlotlyJSONEncoder
            encoder = PlotlyJSONEncoder
        except ImportError:
            pass
        index = 0
        for chart in charts:
            try:
                spec = chart if isinstance(chart, dict) else chart.to_dict()
                if not isinstance(spec, dict) or "data" not in spec:
                    raise ValueError("Expected a Plotly figure or a chart dictionary with data")
                content = json.dumps(spec, cls=encoder, allow_nan=encoder is not None)
                while True:
                    file = Path(output_dir) / f"plotly_chart_{index}.plotly.json"
                    index += 1
                    try:
                        with file.open("x", encoding="utf-8") as stream:
                            stream.write(content)
                    except FileExistsError:
                        continue
                    break
                generated.add(file.name)
                captured.append(chart_metadata(file, spec))
            except Exception:
                failed = True
                traceback.print_exc()
    for name, signature in sorted(output_files(output_dir).items()):
        if not name.endswith(".plotly.json") or name in generated or before.get(name) == signature:
            continue
        file = Path(output_dir) / name
        try:
            with file.open(encoding="utf-8-sig") as stream:
                spec = json.load(stream)
            if isinstance(spec, dict) and "data" in spec:
                captured.append(chart_metadata(file, spec))
        except (OSError, ValueError):
            print(f"Could not read Plotly chart {name}", file=sys.stderr)
    return captured, failed


def capture_metrics(value):
    if isinstance(value, dict):
        try:
            return json.loads(json.dumps(value, default=str, allow_nan=False))
        except (TypeError, ValueError):
            pass
    return None
