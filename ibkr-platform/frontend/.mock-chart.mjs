import * as echarts from "echarts";
import { writeFileSync } from "node:fs";
const pts = [];
for (let p = 6916; p <= 8453; p += 6) {
  const v = 19 * Math.max(0, 7500 - p) * 100 + 15 * Math.max(0, p - 8000) * 100 - 50000 + 200000 * Math.exp(-(((p - 7630) / 40) ** 2)) + 150000 * Math.exp(-(((p - 7840) / 45) ** 2));
  pts.push([p, v]);
}
const bes = [7426, 7517, 7678, 7767, 7915, 8012];
const c = echarts.init(null, null, { renderer: "svg", ssr: true, width: 1400, height: 560 });
c.setOption({
  backgroundColor: "#0b0f14", animation: false,
  legend: { top: 46, left: "center", textStyle: { color: "#9aa" }, data: ["At expiry"] },
  grid: { left: 64, right: 24, top: 132, bottom: 92 },
  xAxis: { type: "value", min: 6916, max: 8453, axisLabel: { color: "#9aa" }, splitLine: { lineStyle: { color: "#1c2430" } } },
  yAxis: { type: "value", axisLabel: { color: "#9aa" }, splitLine: { lineStyle: { color: "#1c2430" } } },
  series: [{ name: "At expiry", type: "line", showSymbol: false, data: pts, lineStyle: { width: 2.5, color: "#3fc59a" },
    markLine: { silent: true, symbol: "none",
      label: { show: true, position: "end", distance: 6, color: "#9aa", fontSize: 11, backgroundColor: "#161d27", borderColor: "#2a3442", borderWidth: 1, padding: [2, 5], borderRadius: 3, formatter: ({ value }) => Math.round(value).toLocaleString() },
      lineStyle: { color: "#3a4656", type: "dashed" },
      data: [{ yAxis: 0, label: { show: false } }, ...bes.map((x, i) => ({ xAxis: x, label: { distance: i % 2 ? 26 : 6 } })), { xAxis: 7690, lineStyle: { color: "#6f8cff", type: "solid" }, label: { show: false } }] } }],
});
writeFileSync(process.argv[2], c.renderToSVGString());
