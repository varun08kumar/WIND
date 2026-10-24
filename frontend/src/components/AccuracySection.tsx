import {
  Bar,
  CartesianGrid,
  Cell,
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
import type { DailyAccuracy, LeadTimeBucket, Meta } from "../types/api";
import { axisTick, useChartColors } from "../lib/chartTheme";
import { fmtDay, fmtHours, fmtMw, fmtNum, fmtPct, fmtShortDay, fmtSignedMw, fmtSignedNum, fmtTimeZ } from "../lib/format";
import { StatCards } from "./StatCards";
import { TimeSeriesChart } from "./TimeSeriesChart";
import { Empty, ErrorState, Loading } from "./States";

interface Props {
  meta: Meta;
  from: string;
  to: string;
  selectedDate: string;
  onRangeChange: (from: string, to: string) => void;
  onSelectDay: (date: string) => void;
  onSelectInterval: (startTime: string) => void;
}

function DailyTooltip({ active, payload }: TooltipProps<number, string>) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload as DailyAccuracy;
  return (
    <div className="tooltip">
      <div className="tooltip__title">{fmtDay(d.delivery_date)}</div>
      <div className="tooltip__row">
        <span className="key key--bar" aria-hidden="true" />
        <strong>{fmtMw(d.summary.mae_mw)}</strong>
        <span>MAE</span>
      </div>
      <div className="tooltip__row">
        <span className="key key--actual" aria-hidden="true" />
        <strong>{fmtSignedMw(d.summary.bias_mw)}</strong>
        <span>Bias</span>
      </div>
      <div className="tooltip__hint">Click to open this delivery day</div>
    </div>
  );
}

function LeadTooltip({ active, payload }: TooltipProps<number, string>) {
  if (!active || !payload?.length) return null;
  const b = payload[0].payload as LeadTimeBucket;
  return (
    <div className="tooltip">
      <div className="tooltip__title">
        {b.min_hours}–{b.max_hours}&nbsp;h ahead
      </div>
      <div className="tooltip__row">
        <span className="key key--bar" aria-hidden="true" />
        <strong>{fmtMw(b.mae_mw)}</strong>
        <span>MAE</span>
      </div>
      <div className="tooltip__row tooltip__row--plain">
        <strong>{fmtSignedMw(b.bias_mw)}</strong>
        <span>Bias · {fmtNum(b.count)} points</span>
      </div>
    </div>
  );
}

export function AccuracySection({ meta, from, to, selectedDate, onRangeChange, onSelectDay, onSelectInterval }: Props) {
  const colors = useChartColors();
  const key = `${from}|${to}`;
  const acc = useResource(key, (s) => api.accuracy(from, to, s));
  const lead = useResource(key, (s) => api.leadTime(from, to, s));
  const series = useResource(key, (s) => api.series(from, to, s));
  const min = meta.data_start_date;
  const max = meta.data_end_date;
  const isFullRange = from === min && to === max;

  const acData = acc.data;
  const decisionLead = acData?.decision_lead_time_hours;

  return (
    <section className="section" aria-labelledby="accuracy-heading">
      <div className="section__head">
        <h2 id="accuracy-heading">Forecast Accuracy Over Delivery Dates</h2>
        <p className="muted">Decision-time forecasts only, evaluated at each hourly WINDFOR point against FUELHH outturn.</p>
      </div>

      <div className="controls" role="group" aria-label="Accuracy date range">
        <label className="field">
          <span>From (UK delivery date)</span>
          <input
            type="date"
            name="from"
            min={min}
            max={to}
            value={from}
            autoComplete="off"
            onChange={(e) => e.target.value && onRangeChange(e.target.value, to < e.target.value ? e.target.value : to)}
          />
        </label>
        <label className="field">
          <span>To (inclusive)</span>
          <input
            type="date"
            name="to"
            min={from}
            max={max}
            value={to}
            autoComplete="off"
            onChange={(e) => e.target.value && onRangeChange(from > e.target.value ? e.target.value : from, e.target.value)}
          />
        </label>
        <button type="button" className="btn" onClick={() => onRangeChange(min, max)} disabled={isFullRange}>
          Full Period ({fmtShortDay(min)} – {fmtShortDay(max)})
        </button>
      </div>

      {acc.error && <ErrorState message={acc.error} onRetry={acc.retry} />}
      {!acc.error && !acData && <Loading label="Loading accuracy…" />}
      {acData && acData.summary.matched_intervals === 0 && (
        <Empty title="No matched forecast and actual data in this range.">
          Load data with <code>python -m scripts.ingest_january_2026</code>, then reload.
        </Empty>
      )}
      {acData && acData.summary.matched_intervals > 0 && (
        <div className={acc.loading ? "is-refreshing" : undefined} aria-busy={acc.loading}>
          <p className="range-label">
            {fmtDay(acData.from)} – {fmtDay(acData.to)} · {fmtNum(acData.summary.matched_intervals)} hourly points ·
            lead times {fmtHours(decisionLead?.min_hours)}–{fmtHours(decisionLead?.max_hours)}
          </p>
          <StatCards summary={acData.summary} showExtended />

          <div className="panel">
            <div className="panel__head">
              <h3>Forecast vs Actual Across the Period (MW)</h3>
              <ul className="legend" aria-label="Legend">
                <li><span className="key key--forecast" aria-hidden="true" /> Forecast at decision time</li>
                <li><span className="key key--actual" aria-hidden="true" /> Actual</li>
                <li><span className="swatch swatch--over" aria-hidden="true" /> Forecast above actual</li>
                <li><span className="swatch swatch--under" aria-hidden="true" /> Forecast below actual</li>
              </ul>
            </div>
            {series.error && <ErrorState message={series.error} onRetry={series.retry} />}
            {!series.error && !series.data && <Loading label="Loading time series…" />}
            {series.data && (
              <div className={series.loading ? "is-refreshing" : undefined}>
                <TimeSeriesChart
                  mode="range"
                  intervals={series.data.intervals}
                  onPick={(i) => onSelectInterval(i.start_time)}
                  pickHint="Click to open this day and hour above"
                />
                <p className="note">Each delivery day uses its own decision-time forecast, so the forecast line can step at midnight.</p>
              </div>
            )}
          </div>

          <div className="panel">
            <div className="panel__head">
              <h3>Daily Error</h3>
              <ul className="legend" aria-label="Legend">
                <li><span className="swatch swatch--bar" aria-hidden="true" /> MAE (MW)</li>
                <li><span className="key key--actual" aria-hidden="true" /> Bias, forecast − actual (MW)</li>
              </ul>
            </div>
            <div className="chart" style={{ height: 280 }}>
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart
                  data={acData.daily}
                  margin={{ top: 8, right: 16, bottom: 4, left: 4 }}
                  onClick={(s: { activePayload?: { payload: DailyAccuracy }[] } | null) => {
                    const day = s?.activePayload?.[0]?.payload;
                    if (day) onSelectDay(day.delivery_date);
                  }}
                >
                  <CartesianGrid stroke={colors.grid} vertical={false} />
                  <XAxis
                    dataKey="delivery_date"
                    tickFormatter={fmtShortDay}
                    tick={axisTick(colors)}
                    stroke={colors.axis}
                    tickLine={false}
                    minTickGap={16}
                  />
                  <YAxis tickFormatter={fmtNum} tick={axisTick(colors)} axisLine={false} tickLine={false} width={56} />
                  <ReferenceLine y={0} stroke={colors.axis} />
                  <Tooltip content={<DailyTooltip />} cursor={{ fill: colors.highlight }} isAnimationActive={false} />
                  <Bar dataKey="summary.mae_mw" radius={[4, 4, 0, 0]} isAnimationActive={false} maxBarSize={18}>
                    {acData.daily.map((d) => (
                      <Cell
                        key={d.delivery_date}
                        fill={colors.forecast}
                        fillOpacity={d.delivery_date === selectedDate ? 1 : 0.55}
                      />
                    ))}
                  </Bar>
                  <Line
                    dataKey="summary.bias_mw"
                    stroke={colors.actual}
                    strokeWidth={2}
                    dot={{ r: 2.5, fill: colors.actual, stroke: colors.surface, strokeWidth: 1 }}
                    isAnimationActive={false}
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
            <p className="note">The selected delivery day is drawn at full strength. Click a day, or use the table, to open it above.</p>
            <details className="details">
              <summary>Daily figures (table)</summary>
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">Delivery date</th>
                      <th scope="col">Forecast used (published)</th>
                      <th scope="col" className="num">MAE MW</th>
                      <th scope="col" className="num">RMSE MW</th>
                      <th scope="col" className="num">Bias MW</th>
                      <th scope="col" className="num">Coverage</th>
                      <th scope="col"><span className="visually-hidden">Actions</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {acData.daily.map((d) => (
                      <tr key={d.delivery_date} className={d.delivery_date === selectedDate ? "is-selected" : undefined}>
                        <th scope="row">{fmtDay(d.delivery_date)}</th>
                        <td className="mono">{d.forecast_publish_times.length ? d.forecast_publish_times.map(fmtTimeZ).join(", ") : "None before cutoff"}</td>
                        <td className="num">{fmtNum(d.summary.mae_mw)}</td>
                        <td className="num">{fmtNum(d.summary.rmse_mw)}</td>
                        <td className="num">{fmtSignedNum(d.summary.bias_mw)}</td>
                        <td className="num">{fmtPct(d.summary.coverage_pct)}</td>
                        <td>
                          <button type="button" className="btn btn--small" onClick={() => onSelectDay(d.delivery_date)} aria-label={`Open ${fmtDay(d.delivery_date)}`}>
                            Open Day
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          </div>
        </div>
      )}

      <div className="panel">
        <div className="panel__head">
          <h3>
            Accuracy by Forecast Horizon <span className="tag">Retrospective</span>
          </h3>
          <p className="muted">
            Every stored WINDFOR vintage, including those published after the decision cutoff, grouped by hours between
            publication and delivery. Use it to judge how much a later decision time would help; it is not what was
            available when buying.
          </p>
        </div>
        {lead.error && <ErrorState message={lead.error} onRetry={lead.retry} />}
        {!lead.error && !lead.data && <Loading label="Loading horizon analysis…" />}
        {lead.data && lead.data.buckets.length === 0 && <Empty title="No vintages with matching actuals in this range." />}
        {lead.data && lead.data.buckets.length > 0 && (
          <div className={lead.loading ? "is-refreshing" : undefined}>
            <ul className="legend" aria-label="Legend">
              <li><span className="swatch swatch--bar" aria-hidden="true" /> MAE (MW)</li>
              {decisionLead?.min_hours != null && (
                <li><span className="swatch swatch--band" aria-hidden="true" /> Horizon of decision-time forecasts ({fmtHours(decisionLead.min_hours)}–{fmtHours(decisionLead.max_hours)})</li>
              )}
            </ul>
            <div className="chart" style={{ height: 240 }}>
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={lead.data.buckets.map((b) => ({ ...b, mid: (b.min_hours + b.max_hours) / 2 }))} margin={{ top: 8, right: 16, bottom: 16, left: 4 }}>
                  <CartesianGrid stroke={colors.grid} vertical={false} />
                  {decisionLead?.min_hours != null && decisionLead.max_hours != null && (
                    <ReferenceArea x1={decisionLead.min_hours} x2={decisionLead.max_hours} fill={colors.highlight} fillOpacity={1} />
                  )}
                  <XAxis
                    dataKey="mid"
                    type="number"
                    domain={[0, lead.data.buckets[lead.data.buckets.length - 1].max_hours]}
                    ticks={lead.data.buckets.map((b) => b.min_hours).concat(lead.data.buckets[lead.data.buckets.length - 1].max_hours)}
                    tick={axisTick(colors)}
                    stroke={colors.axis}
                    tickLine={false}
                    label={{ value: "Hours ahead of delivery", position: "insideBottom", offset: -10, fill: colors.muted, fontSize: 12 }}
                  />
                  <YAxis tickFormatter={fmtNum} tick={axisTick(colors)} axisLine={false} tickLine={false} width={56} />
                  <Tooltip content={<LeadTooltip />} cursor={{ fill: colors.highlight }} isAnimationActive={false} />
                  <Bar dataKey="mae_mw" fill={colors.forecast} radius={[4, 4, 0, 0]} barSize={28} isAnimationActive={false} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
            <p className="note">
              {fmtNum(lead.data.vintages_evaluated)} forecast points evaluated.{" "}
              {lead.data.excluded_non_positive_lead > 0 &&
                `${fmtNum(lead.data.excluded_non_positive_lead)} points published at or after their target hour were excluded. `}
              {lead.data.excluded_missing_actual > 0 && `${fmtNum(lead.data.excluded_missing_actual)} points had no actual. `}
            </p>
            <details className="details">
              <summary>Horizon figures (table)</summary>
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">Hours ahead</th>
                      <th scope="col" className="num">Points</th>
                      <th scope="col" className="num">MAE MW</th>
                      <th scope="col" className="num">RMSE MW</th>
                      <th scope="col" className="num">Bias MW</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lead.data.buckets.map((b) => (
                      <tr key={b.min_hours}>
                        <th scope="row">{b.min_hours}–{b.max_hours}</th>
                        <td className="num">{fmtNum(b.count)}</td>
                        <td className="num">{fmtNum(b.mae_mw)}</td>
                        <td className="num">{fmtNum(b.rmse_mw)}</td>
                        <td className="num">{fmtSignedNum(b.bias_mw)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          </div>
        )}
      </div>
    </section>
  );
}
