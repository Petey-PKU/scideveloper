"""Estimate Kaplan–Meier curves for baseline groups with right-censored follow-up."""

import argparse
import csv
from collections import Counter, defaultdict
from math import erfc, exp, isfinite, log, sqrt
from pathlib import Path
from statistics import NormalDist


def load_cohort(path):
    groups = defaultdict(Counter)
    patient_ids = set()
    with path.open(newline="", encoding="utf-8-sig") as handle:
        reader = csv.DictReader(handle)
        if not {"patient_id", "group", "time", "event"} <= set(reader.fieldnames or []):
            raise ValueError("CSV needs patient_id, group, time and event columns")
        for row in reader:
            patient, group, time, event = (
                (row[column] or "").strip() for column in ("patient_id", "group", "time", "event")
            )
            if not patient or patient in patient_ids or not group or event not in {"0", "1"}:
                raise ValueError(f"Invalid or duplicate patient record at CSV line {reader.line_num}")
            duration = float(time)
            if not isfinite(duration) or duration < 0:
                raise ValueError(f"Expected finite nonnegative time at CSV line {reader.line_num}")
            patient_ids.add(patient)
            groups[group][duration, int(event)] += 1
    if not groups:
        raise ValueError("Cohort is empty")
    return groups


def confidence_interval(survival, greenwood):
    if survival in (0, 1):
        return survival, survival
    center = log(-log(survival))
    margin = NormalDist().inv_cdf(0.975) * sqrt(greenwood) / abs(log(survival))
    return exp(-exp(center + margin)), exp(-exp(center - margin))


def curve(group, counts):
    at_risk = sum(counts.values())
    survival = 1.0
    greenwood = 0.0
    rows = []
    for time in sorted({time for time, _ in counts}):
        events, censored = counts[time, 1], counts[time, 0]
        survival *= 1 - events / at_risk
        if events < at_risk:
            greenwood += events / (at_risk * (at_risk - events))
        lower, upper = confidence_interval(survival, greenwood)
        rows.append({
            "group": group, "time": time, "at_risk": at_risk, "events": events,
            "censored": censored, "survival": survival, "lower_95": lower, "upper_95": upper,
        })
        at_risk -= events + censored
    return rows


def log_rank_p_value(groups):
    """Return a two-sided log-rank p-value for two groups with positive variance."""
    risk = [sum(counts.values()) for counts in groups]
    times = sorted({time for counts in groups for time, _ in counts})
    observed_minus_expected = variance = 0.0
    for time in times:
        events = [counts[time, 1] for counts in groups]
        total_risk, total_events = sum(risk), sum(events)
        fraction = risk[0] / total_risk
        observed_minus_expected += events[0] - total_events * fraction
        if total_risk > 1:
            variance += (total_events * fraction * (1 - fraction)
                         * (total_risk - total_events) / (total_risk - 1))
        risk = [at_risk - count - data[time, 0]
                for at_risk, count, data in zip(risk, events, groups)]
    return erfc(abs(observed_minus_expected) / sqrt(2 * variance)) if variance > 0 else None


def save_plot(path, curves, time_unit):
    from matplotlib.backends.backend_agg import FigureCanvasAgg
    from matplotlib.figure import Figure

    figure = Figure(figsize=(8, 5 + 0.25 * len(curves)), layout="constrained")
    FigureCanvasAgg(figure)
    plot, risk_plot = figure.subplots(2, 1, gridspec_kw={"height_ratios": [5, 1 + len(curves) / 3]})
    end = max(rows[-1]["time"] for rows in curves)
    ticks = [end * fraction / 4 for fraction in range(5)] if end else [0.0]
    risk_table = []
    labels = []
    for rows in curves:
        group = rows[0]["group"]
        times = [0, *(row["time"] for row in rows)]
        line, = plot.step(times, [1, *(row["survival"] for row in rows)], where="post", label=group)
        color = line.get_color()
        plot.fill_between(times, [1, *(row["lower_95"] for row in rows)],
                          [1, *(row["upper_95"] for row in rows)], step="post", color=color, alpha=0.18)
        censored = [row for row in rows if row["censored"]]
        plot.scatter([row["time"] for row in censored], [row["survival"] for row in censored],
                     marker="+", color=color, zorder=3)
        risk_table.append([sum(row["events"] + row["censored"] for row in rows if row["time"] >= tick)
                           for tick in ticks])
        labels.append(group)
    plot.set(xlabel=f"Time ({time_unit})", ylabel="Survival probability", ylim=(0, 1.05), xticks=ticks)
    plot.legend()
    risk_plot.axis("off")
    risk_plot.set_title("Number at risk immediately before each time")
    risk_plot.table(cellText=risk_table, rowLabels=labels, colLabels=[f"{tick:.4g}" for tick in ticks],
                    cellLoc="center", loc="center")
    figure.savefig(path, dpi=160)


def write_csv(path, rows):
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("cohort", type=Path)
    parser.add_argument("output_dir", type=Path)
    parser.add_argument("--time-unit", default="months")
    args = parser.parse_args()
    try:
        groups = load_cohort(args.cohort)
        curves = [curve(group, groups[group]) for group in sorted(groups)]
        args.output_dir.mkdir(parents=True, exist_ok=True)
        save_plot(args.output_dir / "kaplan_meier.png", curves, args.time_unit)
        write_csv(args.output_dir / "survival_curves.csv", [row for rows in curves for row in rows])
        write_csv(args.output_dir / "group_summary.csv", [
            {"group": rows[0]["group"], "n": rows[0]["at_risk"],
             "events": sum(row["events"] for row in rows),
             "median_time": next((row["time"] for row in rows if row["survival"] <= 0.5), None),
             "time_unit": args.time_unit}
            for rows in curves
        ])
        if len(groups) == 2:
            p = log_rank_p_value(list(groups.values()))
            print("Log-rank test variance is zero" if p is None else f"Two-sided log-rank p = {p:.6g}")
    except (OSError, ValueError, ImportError) as error:
        parser.error(str(error))


if __name__ == "__main__":
    main()
