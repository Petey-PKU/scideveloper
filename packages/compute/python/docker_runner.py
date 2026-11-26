"""Bootstrap appended to execution_artifacts.py in the Docker Python process."""

def run_docker_cell():
    marker = sys.argv[1]
    control = sys.stdout
    request = json.load(sys.stdin)
    output = os.environ["SCIDEV_OUTPUT_DIR"]
    namespace = {"__name__": "__scideveloper__", "SCIDEV_OUTPUT_DIR": output,
                 "SCIDEV_WORK_DIR": output, "SCIDEV_WORKSPACE_DIR": os.environ["SCIDEV_WORKSPACE_DIR"]}
    before = output_files(output)
    exit_code = 0
    try:
        exec(compile(request["code"], "<scideveloper-cell>", "exec"), namespace)
    except (Exception, SystemExit):
        exit_code = 1
        traceback.print_exc()
    charts, chart_failed = capture_plotly(output, before, namespace.get("SCIDEV_PLOTLY_CHARTS"))
    figures, figure_failed = export_figures(output, sys.modules.get("matplotlib.pyplot"))
    metrics = capture_metrics(namespace.get("SCIDEV_METRICS"))
    control.write(marker + json.dumps({"metrics": metrics, "figureBundles": figures, "plotlyCharts": charts}) + "\n")
    control.flush()
    return 1 if chart_failed or figure_failed else exit_code


if __name__ == "__main__":
    raise SystemExit(run_docker_cell())
