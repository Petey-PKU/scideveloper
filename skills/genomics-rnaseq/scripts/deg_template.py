"""Fit an independent two-group bulk RNA-seq contrast with PyDESeq2 0.5.x."""

import argparse
import csv
from pathlib import Path


def read_table(path, pandas):
    with path.open(encoding="utf-8-sig", newline="") as handle:
        reader = csv.reader(handle, strict=True)
        columns = next(reader, [])
        if len(columns) < 2 or any(not name.strip() for name in columns[1:]):
            raise ValueError(f"{path} needs an ID column and named data columns")
        if len(set(columns)) != len(columns):
            raise ValueError(f"{path} has duplicate column names")
        rows = []
        for row in reader:
            if not row:
                continue
            if len(row) != len(columns):
                raise ValueError(f"{path} has the wrong number of fields on line {reader.line_num}")
            rows.append(row)

    table = pandas.DataFrame(rows, columns=columns, dtype=str)
    ids = table.iloc[:, 0]
    if ids.empty or ids.duplicated().any() or ids.str.strip().eq("").any():
        raise ValueError(f"{path} needs unique, nonempty sample IDs")
    return table.set_index(table.columns[0])


def prepare_inputs(counts, metadata, condition, tested, reference):
    if set(counts.index) != set(metadata.index):
        raise ValueError("Counts and metadata must contain the same sample IDs")
    metadata = metadata.loc[counts.index].copy()
    if condition not in metadata.columns:
        raise ValueError(f"Metadata is missing condition column {condition!r}")

    groups = metadata[condition].value_counts()
    if tested == reference or set(groups.index) != {tested, reference}:
        raise ValueError("Metadata must contain exactly the distinct tested and reference levels")
    if groups.min() < 2:
        raise ValueError("Each group needs at least two independent biological replicates")

    for gene in counts.columns:
        if not counts[gene].str.fullmatch(r"[0-9]+").all():
            raise ValueError(f"Gene {gene!r} contains missing or non-integer raw counts")
    counts = counts.astype("int64")
    if not counts.gt(0).any(axis=1).all():
        raise ValueError("Each sample needs at least one positive raw count")
    return counts, metadata


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("counts", type=Path, help="CSV with samples as rows and genes as columns")
    parser.add_argument("metadata", type=Path, help="CSV with sample IDs in the first column")
    parser.add_argument("output", type=Path, help="Output CSV for the full contrast")
    parser.add_argument("--condition", default="condition", help="Condition column in metadata")
    parser.add_argument("--tested", required=True, help="Numerator level")
    parser.add_argument("--reference", required=True, help="Denominator level")
    parser.add_argument("--alpha", type=float, default=0.05, help="FDR threshold for independent filtering")
    args = parser.parse_args()

    if not 0 < args.alpha < 1:
        parser.error("--alpha must be strictly between 0 and 1")
    if args.output.resolve() in {args.counts.resolve(), args.metadata.resolve()}:
        parser.error("Output must differ from both inputs")

    try:
        import pandas as pd
        from pydeseq2.dds import DeseqDataSet
        from pydeseq2.ds import DeseqStats
    except ImportError:
        parser.error("This template requires pandas and PyDESeq2 0.5.x")

    try:
        counts, metadata = prepare_inputs(
            read_table(args.counts, pd),
            read_table(args.metadata, pd),
            args.condition,
            args.tested,
            args.reference,
        )
    except (OSError, ValueError, OverflowError, csv.Error) as error:
        parser.error(str(error))

    # A fixed formula also works with metadata column names containing spaces.
    design_metadata = metadata[[args.condition]].set_axis(["condition"], axis="columns")
    dataset = DeseqDataSet(counts=counts, metadata=design_metadata, design="~condition", n_cpus=1)
    dataset.deseq2()
    stats = DeseqStats(
        dataset,
        contrast=["condition", args.tested, args.reference],
        alpha=args.alpha,
        n_cpus=1,
    )
    stats.summary()
    stats.results_df.rename_axis("gene_id").to_csv(args.output, na_rep="NA")


if __name__ == "__main__":
    main()
