"""Run one-sided hypergeometric ORA and correct across all tested GMT sets."""

import argparse
import csv
from math import comb
from pathlib import Path


def read_ids(path):
    return set(path.read_text(encoding="utf-8-sig").split())


def read_gmt(path):
    pathways = {}
    with path.open(encoding="utf-8-sig") as handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            name, *fields = line.rstrip("\r\n").split("\t")
            if not name.strip() or len(fields) < 2 or name in pathways:
                raise ValueError(f"Malformed or duplicate GMT set at line {line_number}")
            description, *members = fields
            genes = {gene.strip() for gene in members if gene.strip()}
            if not genes:
                raise ValueError(f"Empty GMT set at line {line_number}")
            pathways[name] = (description, genes)
    return pathways


def hypergeometric_tail(population, set_size, draws, overlap):
    if overlap == 0:
        return 1.0
    ways = sum(
        comb(set_size, k) * comb(population - set_size, draws - k)
        for k in range(max(overlap, draws - (population - set_size)),
                       min(set_size, draws) + 1)
    )
    return ways / comb(population, draws)


def enrich(hits, background, pathways, min_size, max_size):
    rows = []
    for name, (description, genes) in pathways.items():
        members = genes & background
        if not min_size <= len(members) <= max_size:
            continue
        overlap = sorted(hits & members)
        expected = len(members) * len(hits) / len(background)
        rows.append({
            "pathway": name,
            "description": description,
            "universe_size": len(background),
            "hit_count": len(hits),
            "set_size": len(members),
            "overlap_count": len(overlap),
            "expected_overlap": expected,
            "fold_enrichment": len(overlap) / expected,
            "p_value": hypergeometric_tail(len(background), len(members), len(hits), len(overlap)),
            "overlap_genes": ",".join(overlap),
        })

    rows.sort(key=lambda row: (row["p_value"], row["pathway"]))
    adjusted = 1.0
    for rank in range(len(rows), 0, -1):
        row = rows[rank - 1]
        adjusted = min(adjusted, row["p_value"] * len(rows) / rank)
        row["fdr"] = adjusted
    return rows


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("hits", type=Path)
    parser.add_argument("background", type=Path)
    parser.add_argument("gmt", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--min-size", type=int, default=1)
    parser.add_argument("--max-size", type=int, default=500)
    args = parser.parse_args()

    try:
        if not 1 <= args.min_size <= args.max_size:
            raise ValueError("Set sizes must satisfy 1 <= min-size <= max-size")
        hits, background = read_ids(args.hits), read_ids(args.background)
        if not hits or not background:
            raise ValueError("Hits and background must be nonempty")
        outside = hits - background
        if outside:
            examples = ", ".join(sorted(outside)[:5])
            raise ValueError(f"{len(outside)} hits outside the background (e.g. {examples})")
        rows = enrich(hits, background, read_gmt(args.gmt), args.min_size, args.max_size)
        if not rows:
            raise ValueError("No GMT sets passed the mapped size filters")

        args.output.parent.mkdir(parents=True, exist_ok=True)
        with args.output.open("w", newline="", encoding="utf-8") as handle:
            writer = csv.DictWriter(handle, fieldnames=list(rows[0]), delimiter="\t")
            writer.writeheader()
            writer.writerows(rows)
    except (OSError, ValueError) as error:
        parser.error(str(error))


if __name__ == "__main__":
    main()
