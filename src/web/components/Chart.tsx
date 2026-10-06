import { BarChart, PieChart } from "echarts/charts";
import { GridComponent, TitleComponent, TooltipComponent } from "echarts/components";
import * as echarts from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";
import { useEffect, useRef } from "react";
import type { EChartsOption } from "echarts";

echarts.use([PieChart, BarChart, TitleComponent, TooltipComponent, GridComponent, CanvasRenderer]);

interface Props {
  option: EChartsOption;
  height: number;
  /** Called with the `key` of the tapped datum. */
  onSelect(key: string): void;
  label: string;
  view: string;
}

export function Chart({ option, height, onSelect, label, view }: Props) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts | null>(null);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  useEffect(() => {
    const node = el.current!;
    const instance = echarts.init(node, undefined, { renderer: "canvas" });
    chart.current = instance;
    instance.on("click", (params) => {
      // A tap shows the tooltip and would leave it stuck over the chart; the tap's result
      // (drill or select) says more.
      instance.dispatchAction({ type: "hideTip" });
      const key = (params.data as { key?: string } | undefined)?.key;
      if (key) onSelectRef.current(key);
    });
    const observer = new ResizeObserver(() => instance.resize());
    observer.observe(node);
    return () => {
      observer.disconnect();
      instance.dispose();
      chart.current = null;
    };
  }, []);

  // Within one view, merge so slices and bars animate to their new values; a new view
  // (another report or drill level) starts from a clean chart.
  const lastView = useRef<string | null>(null);
  useEffect(() => {
    chart.current?.dispatchAction({ type: "hideTip" });
    chart.current?.setOption(option, { notMerge: lastView.current !== view });
    lastView.current = view;
  }, [option, view]);

  return <div ref={el} className="chart" style={{ height }} role="img" aria-label={label} data-testid="chart" />;
}
