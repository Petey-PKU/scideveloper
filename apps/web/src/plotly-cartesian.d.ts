declare module 'plotly.js-cartesian-dist-min' {
  const Plotly: {
    newPlot(
      el: HTMLElement,
      data: unknown[],
      layout?: Record<string, unknown>,
      config?: Record<string, unknown>,
    ): Promise<unknown>;
    purge(el: HTMLElement): void;
    Plots?: { resize(el: HTMLElement): void };
    downloadImage?(el: HTMLElement, opts: Record<string, unknown>): Promise<string>;
  };
  export default Plotly;
}
