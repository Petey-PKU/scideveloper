"""Audit numeric consistency and optional Benjamini–Hochberg adjustment in a results CSV."""

import argparse
import csv
import json
import math
from pathlib import Path


def number(value, column, issues, *, probability=False):
    if value is None or value.strip().lower() in {"", "na", "nan", "n/a", "null"}:
        return None
    try:
        parsed = float(value)
    except ValueError:
        issues.append(f"{column} must be numeric")
        return None
    if not math.isfinite(parsed) or (probability and not 0 <= parsed <= 1):
        requirement = "between 0 and 1" if probability else "finite"
        issues.append(f"{column} must be {requirement}")
        return None
    return parsed


def bh_adjust(p_values):
    """Return adjusted p-values keyed by row, with ties handled by cumulative minima."""
    ordered = sorted(p_values.items(), key=lambda item: item[1])
    adjusted = {}
    running_minimum = 1.0
    for rank in range(len(ordered), 0, -1):
        row, p_value = ordered[rank - 1]
        running_minimum = min(running_minimum, p_value * len(ordered) / rank)
        adjusted[row] = running_minimum
    return adjusted


def audit(path, p_column, adjusted_column, interval_columns, tolerance):
    issues_by_row = {}
    raw_p_values = {}
    reported_adjustments = {}
    missing_adjustments = []
    invalid_p_values = False
    row_count = 0

    with path.open(encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle, strict=True)
        fields = reader.fieldnames or []
        required = {p_column, *interval_columns}
        if adjusted_column:
            required.add(adjusted_column)
        if len(set(fields)) != len(fields):
            raise ValueError("CSV header contains duplicate columns")
        if missing := required.difference(fields):
            raise ValueError(f"Missing CSV columns: {', '.join(sorted(missing))}")

        for row_count, row in enumerate(reader, 1):
            issues = []
            if None in row or None in row.values():
                raise ValueError(f"Data row {row_count} has the wrong number of columns")

            raw = number(row[p_column], p_column, issues, probability=True)
            invalid_p_values |= bool(issues)
            if raw is not None:
                raw_p_values[row_count] = raw

            if adjusted_column:
                adjusted = number(row[adjusted_column], adjusted_column, issues, probability=True)
                if adjusted is not None:
                    if raw is None:
                        issues.append("Adjusted p-value has no valid raw p-value")
                    else:
                        reported_adjustments[row_count] = adjusted
                elif raw is not None:
                    missing_adjustments.append(row_count)

            if interval_columns:
                estimate, low, high = (number(row[column], column, issues) for column in interval_columns)
                if low is not None and high is not None:
                    if low > high:
                        issues.append("Interval lower bound exceeds upper bound")
                    elif estimate is not None and not low <= estimate <= high:
                        issues.append("Estimate lies outside the reported interval")
                elif (low is None) != (high is None):
                    issues.append("Interval has only one bound")

            if issues:
                issues_by_row[row_count] = issues

    if not row_count:
        raise ValueError("CSV has no data rows")

    compared = 0
    if adjusted_column and not invalid_p_values:
        for row, expected in bh_adjust(raw_p_values).items():
            if row not in reported_adjustments:
                continue
            compared += 1
            reported = reported_adjustments[row]
            if abs(reported - expected) > tolerance:
                issues_by_row.setdefault(row, []).append(
                    f"Adjusted p-value {reported:g} differs from BH expectation {expected:g}"
                )

    return {
        "rows": row_count,
        "valid_raw_p_values": len(raw_p_values),
        "bh_comparisons": compared,
        "bh_skipped_invalid_raw_p_values": bool(adjusted_column and invalid_p_values),
        "rows_with_raw_but_no_valid_adjustment": missing_adjustments,
        "issues": [{"data_row": row, "findings": issues} for row, issues in sorted(issues_by_row.items())],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("results", type=Path)
    parser.add_argument("--p-value", default="pvalue", help="Raw p-value column")
    parser.add_argument("--adjusted", help="BH-adjusted p-value column")
    parser.add_argument("--estimate", help="Effect estimate column")
    parser.add_argument("--low", help="Interval lower bound column")
    parser.add_argument("--high", help="Interval upper bound column")
    parser.add_argument("--tolerance", type=float, default=1e-6, help="Absolute BH comparison tolerance")
    args = parser.parse_args()
    intervals = tuple(column for column in (args.estimate, args.low, args.high) if column is not None)
    if intervals and len(intervals) != 3:
        parser.error("--estimate, --low and --high must be supplied together")
    if not math.isfinite(args.tolerance) or args.tolerance < 0:
        parser.error("--tolerance must be finite and nonnegative")

    try:
        report = audit(args.results, args.p_value, args.adjusted, intervals, args.tolerance)
    except (OSError, ValueError, csv.Error) as error:
        parser.error(str(error))
    print(json.dumps(report, indent=2))
    return int(bool(report["issues"]))


if __name__ == "__main__":
    raise SystemExit(main())
