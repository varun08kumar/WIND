import {
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { TooltipProps } from "recharts";
import { api, useResource } from "../api/client";
import type { Vintage } from "../types/api";
import { axisTick, useChartColors } from "../lib/chartTheme";
import { fmtDateTime, fmtHours, fmtMw, fmtNum, fmtShortDateTime, fmtSignedMw, fmtSignedNum, fmtTime, fmtTimeZ } from "../lib/format";
import { Empty, ErrorState, Loading } from "./States";

interface Row extends Vintage {
  t: number;
}

function VintageTooltip({ active, payload }: TooltipProps<number, string>) {
  if (!active || !payload?.length) return null;
  const v = payload[0].payload as Row;
  return (
    <div className="tooltip">
      <div className="tooltip__title">Published {fmtDateTime(v.publish_time)}</div>
      <div className="tooltip__row">
        <span className="key key--forecast" aria-hidden="true" />
        <strong>{fmtMw(v.generation_mw)}</strong>
        <span>Forecast · {fmtHours(v.lead_time_hours)} ahead</span>
      </div>
      {v.error_mw != null && (
        <div className="tooltip__row tooltip__row--plain">
          <strong>{fmtSignedMw(v.error_mw)}</strong>
          <span>Error vs actual</span>
        </div>
      )}
      <div className="tooltip__hint">
        {v.selected ? "Used for the decision" : v.available_at_decision ? "Available, superseded before cutoff" : "Published after the cutoff"}
      </div>
    </div>
  );
}

export function VintagePanel({ startTime }: { startTime: string }) {
  const colors = useChartColors();
  const res = useResource(startTime, (s) => api.vintages(startTime, s));
  const data = res.data;

  const end = new Date(Date.parse(startTime) + 30 * 60_000).toISOString();
  const heading = `${fmtTime(startTime)}–${fmtTimeZ(end)}`;

  let body;
  if (res.error) body = <ErrorState message={res.error} onRetry={res.retry} />;
  else if (!data) body = <Loading label="Loading vintages…" />;
  else if (!data.vintages.length)
    body = <Empty title="No forecast vintages stored for this interval.">Run the ingestion command to load WINDFOR data.</Empty>;
  else {
    const rows: Row[] = data.vintages.map((v) => ({ ...v, t: Date.parse(v.publish_time) }));
    const cutoffT = Date.parse(data.decision_cutoff);
    const lastT = rows[rows.length - 1].t;
    const selected = rows.find((r) => r.selected);
    const values = rows.map((r) => r.generation_mw).concat(data.actual_mw != null ? [data.actual_mw] : []);
    const pad = Math.max(200, (Math.max(...values) - Math.min(...values)) * 0.08);
    const yDomain = [Math.max(0, Math.floor((Math.min(...values) - pad) / 100) * 100), Math.ceil((Math.max(...values) + pad) / 100) * 100];
    body = (
      <div className={res.loading ? "is-refreshing" : undefined}>
        <ul className="legend" aria-label="Legend">
          <li><span className="key key--forecast" aria-hidden="true" /> Forecast by publish time</li>
          <li><span className="dot dot--selected" aria-hidden="true" /> Used at decision time</li>
          <li><span className="dot dot--late" aria-hidden="true" /> Published after cutoff</li>
          {data.actual_mw != null && <li><span className="key key--actual" aria-hidden="true" /> Actual {fmtMw(data.actual_mw)}</li>}
        </ul>
        <div className="chart" style={{ height: 260 }}>
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={rows} margin={{ top: 20, right: 16, bottom: 4, left: 4 }}>
              <CartesianGrid stroke={colors.grid} vertical={false} />
              {lastT > cutoffT && <ReferenceArea x1={cutoffT} x2={lastT} fill={colors.missing} fillOpacity={1} />}
              <XAxis
                dataKey="t"
                type="number"
                scale="time"
                domain={["dataMin", "dataMax"]}
                tickFormatter={(t: number) => fmtShortDateTime(new Date(t).toISOString())}
                tick={axisTick(colors)}
                stroke={colors.axis}
                tickLine={false}
                minTickGap={40}
              />
              <YAxis tickFormatter={fmtNum} tick={axisTick(colors)} axisLine={false} tickLine={false} width={56} domain={yDomain} />
              <ReferenceLine
                x={cutoffT}
                stroke={colors.text}
                label={{ value: "Decision cutoff", position: "insideTopRight", fill: colors.text, fontSize: 12, dy: -18 }}
              />
              {data.actual_mw != null && <ReferenceLine y={data.actual_mw} stroke={colors.actual} strokeWidth={2} />}
              <Tooltip content={<VintageTooltip />} cursor={{ stroke: colors.muted }} isAnimationActive={false} />
              <Line
                dataKey="generation_mw"
                stroke={colors.forecast}
                strokeWidth={2}
                isAnimationActive={false}
                dot={(p: { cx?: number; cy?: number; payload?: Row; index?: number }) => {
                  if (p.cx == null || p.cy == null || !p.payload) return <g key={p.index} />;
                  if (p.payload.selected)
                    return <circle key={p.index} cx={p.cx} cy={p.cy} r={6} fill={colors.forecast} stroke={colors.surface} strokeWidth={2} />;
                  if (!p.payload.available_at_decision)
                    return <circle key={p.index} cx={p.cx} cy={p.cy} r={3.5} fill={colors.surface} stroke={colors.muted} strokeWidth={1.5} />;
                  return <circle key={p.index} cx={p.cx} cy={p.cy} r={3.5} fill={colors.forecast} stroke={colors.surface} strokeWidth={1.5} />;
                }}
                activeDot={{ r: 5, stroke: colors.surface, strokeWidth: 2 }}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        <p className="note">
          {selected
            ? `Used at decision time: published ${fmtDateTime(selected.publish_time)}, ${fmtHours(selected.lead_time_hours)} ahead. `
            : "No vintage was published before the cutoff, so this hour has no decision-time forecast. "}
          Shaded: published after the decision cutoff ({fmtDateTime(data.decision_cutoff)}), shown for retrospective comparison only.
        </p>
        <details className="details">
          <summary>All {rows.length} vintages (table)</summary>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Published (UK)</th>
                  <th scope="col" className="num">Lead time</th>
                  <th scope="col" className="num">Forecast MW</th>
                  <th scope="col" className="num">Error MW</th>
                  <th scope="col">At decision time</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((v) => (
                  <tr key={v.publish_time} className={v.selected ? "is-selected" : undefined}>
                    <th scope="row" className="mono">{fmtDateTime(v.publish_time)}</th>
                    <td className="num">{fmtHours(v.lead_time_hours)}</td>
                    <td className="num">{fmtNum(v.generation_mw)}</td>
                    <td className="num">{fmtSignedNum(v.error_mw)}</td>
                    <td>{v.selected ? <span className="badge badge--matched">Used</span> : v.available_at_decision ? "Available (superseded)" : "Not yet published"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      </div>
    );
  }

  return (
    <section className="panel" aria-labelledby="vintage-heading">
      <div className="panel__head">
        <h3 id="vintage-heading">Forecast vintages for {heading}</h3>
        <p className="muted">How the WINDFOR forecast for this hour evolved, and which version was available when buying.</p>
      </div>
      {body}
    </section>
  );
}
