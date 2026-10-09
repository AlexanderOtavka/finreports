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
}

/**
 * Every component type the reports use. `setOption` replaces these outright instead of merging
 * into the last option, so nothing from the last option stays on screen (a series the new one
 * no longer has, a property it leaves out); a series with the same `id` still animates to its
 * new values.
 */
const REPLACE = ["series", "title", "tooltip", "grid", "xAxis", "yAxis"];

const seriesOf = (option: EChartsOption) => (Array.isArray(option.series) ? option.series : option.series ? [option.series] : []);

/** The series' types and ids, in order. */
const seriesShape = (option: EChartsOption) => JSON.stringify(seriesOf(option).map((s) => [s.type, s.id ?? null]));

/**
 * Makes the selected marks those of `option`'s data (`selected: true`), and only those. ECharts
 * keeps its own selection, which a tap toggles and a merged option only ever adds to, so it is
 * set from the option after every change.
 */
function syncSelection(instance: echarts.ECharts, option: EChartsOption) {
  seriesOf(option).forEach((s, seriesIndex) => {
    const data = (s as { selectedMode?: unknown; data?: unknown }).data;
    if (!(s as { selectedMode?: unknown }).selectedMode || !Array.isArray(data)) return;
    const all = data.map((_, i) => i);
    const selected = all.filter((i) => (data[i] as { selected?: boolean } | null)?.selected);
    instance.dispatchAction({ type: "unselect", seriesIndex, dataIndex: all });
    if (selected.length) instance.dispatchAction({ type: "select", seriesIndex, dataIndex: selected });
  });
}

function columnKeys(option: EChartsOption): string[] | null {
  const axis = Array.isArray(option.xAxis) ? option.xAxis[0] : option.xAxis;
  const data = (axis as { data?: unknown[] } | undefined)?.data;
  if (!data?.length || typeof data[0] !== "object" || !(data[0] as { key?: string }).key) return null;
  return data.map((d) => (d as { key: string }).key);
}

export function Chart({ option, height, onSelect, label }: Props) {
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
      // What is selected is the app's to say: undo the tap's own toggle, which ECharts makes
      // after this handler (a new option follows if the tap changed the selection).
      queueMicrotask(() => {
        if (!instance.isDisposed()) syncSelection(instance, optionRef.current);
      });
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

  // The chart shows `option` and nothing else, however it got here. It animates from the last
  // option only when both have the same series in the same order: ECharts keeps a series it
  // reuses at its old place, so a series added or dropped could change the stacking order.
  // Otherwise it draws afresh (with its opening animation).
  const shown = useRef<string | null>(null);
  useEffect(() => {
    const instance = chart.current;
    if (!instance) return;
    instance.dispatchAction({ type: "hideTip" });
    const shape = seriesShape(option);
    instance.setOption(option, shape === shown.current ? { replaceMerge: REPLACE } : { notMerge: true });
    shown.current = shape;
    syncSelection(instance, option);
  }, [option]);

  return <div ref={el} className="chart" style={{ height }} role="img" aria-label={label} data-testid="chart" />;
}
