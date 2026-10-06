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

function columnKeys(option: EChartsOption): string[] | null {
  const axis = Array.isArray(option.xAxis) ? option.xAxis[0] : option.xAxis;
  const data = (axis as { data?: unknown[] } | undefined)?.data;
  if (!data?.length || typeof data[0] !== "object" || !(data[0] as { key?: string }).key) return null;
  return data.map((d) => (d as { key: string }).key);
}

export function Chart({ option, height, onSelect, label, view }: Props) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts | null>(null);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const optionRef = useRef(option);
  optionRef.current = option;

  useEffect(() => {
    const node = el.current!;
    const instance = echarts.init(node, undefined, { renderer: "canvas" });
    chart.current = instance;
    instance.on("click", (params) => {
      if (columnKeys(optionRef.current)) return; // handled below, for the whole column
      // A tap shows the tooltip and would leave it stuck over the chart; the tap's result
      // (drill or select) says more.
      instance.dispatchAction({ type: "hideTip" });
      const key = (params.data as { key?: string } | undefined)?.key;
      if (key) onSelectRef.current(key);
    });
    // Column charts (category axis entries carrying a `key`): a tap anywhere in a column
    // selects it, not only on its bar, so short bars and thin segments are easy targets.
    instance.getZr().on("click", (e) => {
      const keys = columnKeys(optionRef.current);
      if (!keys || !instance.containPixel("grid", [e.offsetX, e.offsetY])) return;
      const [index] = instance.convertFromPixel({ gridIndex: 0 }, [e.offsetX, e.offsetY]) as number[];
      const key = keys[Math.round(index ?? -1)];
      instance.dispatchAction({ type: "hideTip" });
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
