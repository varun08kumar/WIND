import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  Area,
  Bar,
  Brush,
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
import type { Interval } from "../types/api";
import { axisTick, useChartColors } from "../lib/chartTheme";
import {
  fmtMw,
  fmtNum,
  fmtShortDateTime,
  fmtShortDay,
  fmtSignedMw,
  fmtTime,
  ukDate,
  ukHour,
  ukZone,
} from "../lib/format";

const HALF_HOUR = 1_800_000;
const HOUR = 2 * HALF_HOUR;
const DAY = 24 * HOUR;
const Y_AXIS_WIDTH = 56;
const MARGIN = { top: 12, right: 16, bottom: 4, left: 4 };
const MIN_SPAN = 4;

interface Row {
  t: number;
  interval: Interval;
  actual: number | null;
  forecast: number | null;
  forecastLine: number | null;
  over: [number, number] | null;
  under: [number, number] | null;
  error: number | null;
  errOver: number | null;
  errUnder: number | null;
}

interface Preset {
  label: string;
  start: number;
  end: number;
}

function buildRows(intervals: Interval[]): Row[] {
  return intervals.map((interval, i) => {
    let line = interval.forecast_mw;
    if (line == null && interval.status === "no_forecast_point") {
      const prev = intervals[i - 1]?.forecast_mw;
      const next = intervals[i + 1]?.forecast_mw;
      line = prev != null && next != null ? (prev + next) / 2 : null;
    }
    const a = interval.actual_mw;
    return {
      t: Date.parse(interval.start_time),
      interval,
      actual: a,
      forecast: interval.forecast_mw,
      forecastLine: line,
      over: line != null && a != null ? [a, Math.max(a, line)] : null,
      under: line != null && a != null ? [Math.min(a, line), a] : null,
      error: interval.error_mw,
      errOver: interval.error_mw == null ? null : Math.max(interval.error_mw, 0),
      errUnder: interval.error_mw == null ? null : Math.min(interval.error_mw, 0),
    };
  });
}

function dayPresets(rows: Row[]): Preset[] {
  if (!rows.length) return [];
  const end = rows[rows.length - 1].t + HALF_HOUR;
  const at = (hour: number) => rows.find((r) => ukHour(r.interval.start_time) >= hour)?.t ?? end;
  return [
    { label: "Night 00–06", start: at(0), end: at(6) },
    { label: "Morning 06–12", start: at(6), end: at(12) },
    { label: "Afternoon 12–18", start: at(12), end: at(18) },
    { label: "Evening 18–24", start: at(18), end },
  ];
}

function weekPresets(rows: Row[]): Preset[] {
  const dayStarts: { date: string; t: number }[] = [];
  for (const r of rows) {
    const date = ukDate(r.interval.start_time);
    if (dayStarts[dayStarts.length - 1]?.date !== date) dayStarts.push({ date, t: r.t });
  }
  if (dayStarts.length <= 7) return [];
  const end = rows[rows.length - 1].t + HALF_HOUR;
  const presets: Preset[] = [];
  for (let i = 0; i < dayStarts.length; i += 7) {
    const last = dayStarts[Math.min(i + 6, dayStarts.length - 1)];
    presets.push({
      label: `${fmtShortDay(dayStarts[i].date)}–${fmtShortDay(last.date)}`,
      start: dayStarts[i].t,
      end: dayStarts[i + 7]?.t ?? end,
    });
  }
  return presets;
}

/** Ticks aligned to UK local hours/days, spaced for the visible span. */
function makeTicks(rows: Row[]): { ticks: number[]; format: (t: number) => string } {
  if (!rows.length) return { ticks: [], format: String };
  const span = rows[rows.length - 1].t - rows[0].t;
  const iso = (t: number) => new Date(t).toISOString();
  const onHour = (r: Row) => r.interval.start_time.slice(14, 16) === "00";
  if (span <= 1.5 * DAY) {
    const step = span <= 6 * HOUR ? 1 : span <= 12 * HOUR ? 2 : 3;
    return {
      ticks: rows.filter((r) => onHour(r) && ukHour(r.interval.start_time) % step === 0).map((r) => r.t),
      format: (t) => fmtTime(iso(t)),
    };
  }
  if (span <= 4 * DAY) {
    return {
      ticks: rows.filter((r) => onHour(r) && ukHour(r.interval.start_time) % 12 === 0).map((r) => r.t),
      format: (t) => fmtShortDateTime(iso(t)),
    };
  }
  const midnights = rows.filter((r) => onHour(r) && ukHour(r.interval.start_time) === 0);
  const every = Math.max(1, Math.ceil(midnights.length / 10));
  return {
    ticks: midnights.filter((_, i) => i % every === 0).map((r) => r.t),
    format: (t) => fmtShortDay(ukDate(iso(t))),
  };
}

/** Round-number ticks (1, 2, 2.5, 5 × 10ⁿ) covering [lo, hi]. */
function niceTicks(lo: number, hi: number, count: number): number[] {
  if (hi <= lo) hi = lo + 1;
  const raw = (hi - lo) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((st) => st >= raw) ?? 10 * mag;
  const ticks: number[] = [];
  for (let v = Math.floor(lo / step) * step; v < hi + step - 1e-9; v += step) ticks.push(Math.round(v));
  return ticks;
}

/** "24:00 GMT" rather than "00:00 GMT" when a range ends at local midnight. */
function endOfDayLabel(iso: string): string {
  const time = fmtTime(iso);
  return `${time === "00:00" ? "24:00" : time} ${ukZone(iso)}`;
}

function forecastText(interval: Interval): string {
  if (interval.forecast_mw != null) return fmtMw(interval.forecast_mw);
  if (interval.status === "no_forecast_point") return "No point (WINDFOR is hourly)";
  return "No eligible forecast";
}

function ChartTooltip({ active, payload, showDate, hint }: TooltipProps<number, string> & { showDate?: boolean; hint?: string }) {
  if (!active || !payload?.length) return null;
  const { interval } = payload[0].payload as Row;
  const err = interval.error_mw;
  return (
    <div className="tooltip">
      <div className="tooltip__title">
        {showDate ? `${fmtShortDay(ukDate(interval.start_time))}, ` : ""}
        {fmtTime(interval.start_time)}–{endOfDayLabel(interval.end_time)}
      </div>
      <div className="tooltip__row">
        <span className="key key--forecast" aria-hidden="true" />
        <span className="tooltip__label">Forecast</span>
        <strong>{forecastText(interval)}</strong>
      </div>
      <div className="tooltip__row">
        <span className="key key--actual" aria-hidden="true" />
        <span className="tooltip__label">Actual</span>
        <strong>{interval.actual_mw != null ? fmtMw(interval.actual_mw) : "Not available"}</strong>
      </div>
      {err != null && (
        <div className="tooltip__row tooltip__row--total">
          <span className={`swatch ${err >= 0 ? "swatch--over" : "swatch--under"}`} aria-hidden="true" />
          <span className="tooltip__label">{err > 0 ? "Forecast too high" : err < 0 ? "Forecast too low" : "Exact"}</span>
          <strong>{fmtSignedMw(err)}</strong>
        </div>
      )}
      {hint && <div className="tooltip__hint">{hint}</div>}
    </div>
  );
}

function Traveller({ x, y, width, height }: { x: number; y: number; width: number; height: number }) {
  const cx = x + width / 2;
  const mid = y + height / 2;
  return (
    <g className="traveller">
      <rect x={x} y={y + 4} width={width} height={height - 8} rx={4} />
      <line x1={cx - 1.5} x2={cx - 1.5} y1={mid - 5} y2={mid + 5} />
      <line x1={cx + 1.5} x2={cx + 1.5} y1={mid - 5} y2={mid + 5} />
    </g>
  );
}

function Icon({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  );
}

interface Props {
  intervals: Interval[];
  mode: "day" | "range";
  selectedStart?: string | null;
  onPick: (interval: Interval) => void;
  pickHint: string;
}

export function TimeSeriesChart({ intervals, mode, selectedStart = null, onPick, pickHint }: Props) {
  const colors = useChartColors();
  const rows = useMemo(() => buildRows(intervals), [intervals]);
  const presets = useMemo(() => (mode === "day" ? dayPresets(rows) : weekPresets(rows)), [rows, mode]);

  const [range, setRange] = useState<[number, number] | null>(null);
  const [brushKey, setBrushKey] = useState(0);
  const [fitY, setFitY] = useState(false);
  const [drag, setDrag] = useState<{ a: number; b: number } | null>(null);
  const suppressClick = useRef(false);
  const plotRef = useRef<HTMLDivElement>(null);
  const wheelAcc = useRef(0);

  useEffect(() => {
    setRange(null);
    setBrushKey((k) => k + 1);
  }, [intervals]);

  const n = rows.length;
  const [s, e] = range ?? [0, Math.max(0, n - 1)];

  const apply = (ns: number, ne: number) => {
    ns = Math.max(0, ns);
    ne = Math.min(n - 1, ne);
    if (ne - ns + 1 < MIN_SPAN) return;
    setRange(ns === 0 && ne === n - 1 ? null : [ns, ne]);
    setBrushKey((k) => k + 1);
  };
  /** Zoom by `factor`, keeping the row at fraction `frac` of the view in place. */
  const zoomAround = (frac: number, factor: number) => {
    const span = e - s + 1;
    let next = Math.round(span * factor);
    next = factor < 1 ? Math.min(span - 1, next) : Math.max(span + 1, next);
    next = Math.max(MIN_SPAN, Math.min(n, next));
    if (next === span) return;
    const anchor = s + frac * (span - 1);
    const ns = Math.round(Math.min(Math.max(anchor - frac * (next - 1), 0), n - next));
    apply(ns, ns + next - 1);
  };
  const pan = (by: number) => {
    const span = e - s + 1;
    const ns = Math.min(Math.max(s + by, 0), n - span);
    if (ns !== s) apply(ns, ns + span - 1);
  };
  const panStep = Math.max(1, Math.round((e - s + 1) / 4));

  const wheelRef = useRef<(ev: WheelEvent) => void>(() => undefined);
  wheelRef.current = (ev: WheelEvent) => {
    const el = plotRef.current;
    if (!el) return;
    if (ev.ctrlKey || ev.metaKey) {
      ev.preventDefault();
      wheelAcc.current += ev.deltaY;
      if (Math.abs(wheelAcc.current) < 6) return;
      const box = el.getBoundingClientRect();
      const left = box.left + MARGIN.left + Y_AXIS_WIDTH;
      const width = box.width - MARGIN.left - Y_AXIS_WIDTH - MARGIN.right;
      const frac = Math.min(1, Math.max(0, (ev.clientX - left) / width));
      zoomAround(frac, Math.exp(Math.max(-0.5, Math.min(0.5, wheelAcc.current * 0.01))));
      wheelAcc.current = 0;
      return;
    }
    const sideways = Math.abs(ev.deltaX) > Math.abs(ev.deltaY) || ev.shiftKey;
    if (sideways && range) {
      ev.preventDefault();
      wheelAcc.current += ev.deltaX || ev.deltaY;
      const pxPerRow = Math.max(4, 600 / (e - s + 1));
      const by = Math.trunc(wheelAcc.current / pxPerRow);
      if (by) {
        pan(by);
        wheelAcc.current -= by * pxPerRow;
      }
    }
  };
  useEffect(() => {
    const el = plotRef.current;
    if (!el) return;
    const listener = (ev: WheelEvent) => wheelRef.current(ev);
    el.addEventListener("wheel", listener, { passive: false });
    return () => el.removeEventListener("wheel", listener);
  }, [n]);

  if (!n) return null;

  const visible = rows.slice(s, e + 1);
  const zoomed = s > 0 || e < n - 1;
  const domainStart = visible[0].t;
  const domainEnd = visible[visible.length - 1].t + HALF_HOUR;
  const { ticks, format } = makeTicks(visible);
  const iso = (t: number) => new Date(t).toISOString();

  const zoomTo = (from: number, to: number) => {
    const si = rows.findIndex((r) => r.t >= from);
    let ei = -1;
    for (let i = n - 1; i >= 0; i--) {
      if (rows[i].t < to) {
        ei = i;
        break;
      }
    }
    if (si < 0 || ei < si) return;
    apply(si, ei);
  };
  const reset = () => apply(0, n - 1);
  const activePreset = presets.find((p) => zoomed && p.start === domainStart && p.end === domainEnd);

  const values = visible.flatMap((r) => [r.actual, r.forecastLine]).filter((v): v is number => v != null);
  const hiVal = values.length ? Math.max(...values) : 1000;
  const loVal = values.length ? Math.min(...values) : 0;
  const pad = (hiVal - loVal) * 0.05;
  const yTicks = fitY ? niceTicks(Math.max(0, loVal - pad), hiVal + pad, 5) : niceTicks(0, hiVal * 1.04, 5);
  const yDomain: [number, number] = [yTicks[0], yTicks[yTicks.length - 1]];

  const errors = visible.map((r) => r.error).filter((v): v is number => v != null);
  const errTicks = errors.length ? niceTicks(Math.min(0, ...errors), Math.max(0, ...errors), 4) : [0, 1];
  const errDomain: [number, number] = [errTicks[0], errTicks[errTicks.length - 1]];

  const matched = visible.filter((r): r is Row & { error: number } => r.error != null);
  const mae = matched.length ? matched.reduce((sum, r) => sum + Math.abs(r.error), 0) / matched.length : null;
  const bias = matched.length ? matched.reduce((sum, r) => sum + r.error, 0) / matched.length : null;
  const worst = matched.reduce<(Row & { error: number }) | null>((w, r) => (!w || Math.abs(r.error) > Math.abs(w.error) ? r : w), null);
  const whenLabel = (t: number) => (mode === "range" ? `${fmtShortDay(ukDate(iso(t)))} ${fmtTime(iso(t))}` : fmtTime(iso(t)));

  const missing = visible.filter((r) => r.interval.status === "missing_forecast" || r.interval.status === "missing_both");
  const selectedT = selectedStart ? Date.parse(selectedStart) : null;
  const showSelected = selectedT != null && selectedT >= domainStart && selectedT < domainEnd;
  const dense = visible.length > 120;

  type ChartState = { activeLabel?: string | number; activePayload?: { payload: Row }[] } | null;
  const handleDown = (st: ChartState) => {
    if (st?.activeLabel != null) setDrag({ a: Number(st.activeLabel), b: Number(st.activeLabel) });
  };
  const handleMove = (st: ChartState) => {
    if (drag && st?.activeLabel != null) setDrag({ a: drag.a, b: Number(st.activeLabel) });
  };
  const handleUp = () => {
    if (drag && Math.abs(drag.b - drag.a) >= HOUR) {
      zoomTo(Math.min(drag.a, drag.b), Math.max(drag.a, drag.b) + HALF_HOUR);
      suppressClick.current = true;
    }
    setDrag(null);
  };
  const handleClick = (st: ChartState) => {
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    const row = st?.activePayload?.[0]?.payload;
    if (!row) return;
    const target = row.forecast != null ? row : rows.find((r) => r.t === row.t - HALF_HOUR && r.forecast != null) ?? row;
    onPick(target.interval);
  };
  const handleKey = (ev: ReactKeyboardEvent) => {
    if (ev.altKey || ev.ctrlKey || ev.metaKey) return;
    const actions: Record<string, () => void> = {
      "+": () => zoomAround(0.5, 0.5),
      "=": () => zoomAround(0.5, 0.5),
      "-": () => zoomAround(0.5, 2),
      ArrowLeft: () => pan(-panStep),
      ArrowRight: () => pan(panStep),
      "0": reset,
      Escape: reset,
    };
    const action = actions[ev.key];
    if (action) {
      ev.preventDefault();
      action();
    }
  };

  const tooltip = <ChartTooltip showDate={mode === "range"} hint={pickHint} />;
  const syncId = `ts-${mode}`;

  return (
    <div className="ts">
      <div className="toolbar">
        <div className="segmented" role="group" aria-label="Zoom presets">
          <button type="button" className="seg" aria-pressed={!zoomed} onClick={reset}>
            {mode === "day" ? "Full Day" : "Full Period"}
          </button>
          {presets.map((p) => (
            <button
              key={p.label}
              type="button"
              className="seg"
              aria-pressed={activePreset === p}
              onClick={() => zoomTo(p.start, p.end)}
            >
              {p.label}
            </button>
          ))}
        </div>
        <div className="toolbar__end">
          <div className="icon-group" role="group" aria-label="Zoom and pan">
            <button type="button" className="icon-btn" aria-label="Pan earlier" title="Pan earlier (←)" disabled={s === 0} onClick={() => pan(-panStep)}>
              <Icon d="M10 3.5 5.5 8l4.5 4.5" />
            </button>
            <button type="button" className="icon-btn" aria-label="Zoom out" title="Zoom out (−)" disabled={!zoomed} onClick={() => zoomAround(0.5, 2)}>
              <Icon d="M3.5 8h9" />
            </button>
            <button type="button" className="icon-btn" aria-label="Zoom in" title="Zoom in (+)" disabled={e - s + 1 <= MIN_SPAN} onClick={() => zoomAround(0.5, 0.5)}>
              <Icon d="M3.5 8h9M8 3.5v9" />
            </button>
            <button type="button" className="icon-btn" aria-label="Pan later" title="Pan later (→)" disabled={e === n - 1} onClick={() => pan(panStep)}>
              <Icon d="m6 3.5 4.5 4.5L6 12.5" />
            </button>
          </div>
          <label className="toggle">
            <input type="checkbox" checked={fitY} onChange={(ev) => setFitY(ev.target.checked)} />
            Fit Y-axis
          </label>
        </div>
      </div>

      <div className="view-bar">
        <p className="range-status" aria-live="polite">
          {zoomed ? "Zoomed to " : "Showing "}
          {mode === "range" || domainEnd - domainStart > DAY
            ? `${fmtShortDateTime(iso(domainStart))} – ${fmtShortDateTime(iso(domainEnd))} ${ukZone(iso(domainEnd))}`
            : `${fmtTime(iso(domainStart))}–${endOfDayLabel(iso(domainEnd))}`}
        </p>
        {mae != null && (
          <dl className="view-stats" aria-label="Accuracy within the visible range">
            <div>
              <dt>MAE in view</dt>
              <dd>{fmtMw(mae)}</dd>
            </div>
            <div>
              <dt>Bias</dt>
              <dd>{fmtSignedMw(bias)}</dd>
            </div>
            {worst && (
              <div>
                <dt>Largest miss</dt>
                <dd>
                  {fmtSignedMw(worst.error)} <span className="muted">at {whenLabel(worst.t)}</span>
                </dd>
              </div>
            )}
          </dl>
        )}
      </div>

      <div
        ref={plotRef}
        className={`plot${drag ? " is-dragging" : ""}`}
        tabIndex={0}
        role="group"
        aria-label="Forecast vs actual chart. Plus and minus keys zoom, arrow keys pan, Escape resets."
        onKeyDown={handleKey}
      >
        <div className="chart" style={{ height: mode === "day" ? 340 : 360 }}>
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart
              data={visible}
              syncId={syncId}
              margin={MARGIN}
              onMouseDown={handleDown}
              onMouseMove={handleMove}
              onMouseUp={handleUp}
              onMouseLeave={() => setDrag(null)}
              onClick={handleClick}
            >
              <CartesianGrid stroke={colors.grid} strokeDasharray="2 4" vertical={false} />
              <XAxis
                dataKey="t"
                type="number"
                scale="time"
                domain={[domainStart, domainEnd]}
                ticks={ticks}
                tickFormatter={format}
                tick={axisTick(colors)}
                stroke={colors.axis}
                tickLine={false}
                tickMargin={6}
                allowDataOverflow
              />
              <YAxis
                tickFormatter={fmtNum}
                tick={axisTick(colors)}
                axisLine={false}
                tickLine={false}
                width={Y_AXIS_WIDTH}
                domain={yDomain}
                ticks={yTicks}
                allowDataOverflow
              />
              {missing.map((r) => (
                <ReferenceArea key={r.t} x1={r.t} x2={r.t + HOUR} fill={colors.missing} fillOpacity={1} ifOverflow="hidden" />
              ))}
              {showSelected && (
                <ReferenceArea
                  x1={selectedT}
                  x2={selectedT + HOUR}
                  fill={colors.highlight}
                  fillOpacity={1}
                  stroke={colors.forecast}
                  strokeOpacity={0.35}
                  ifOverflow="hidden"
                />
              )}
              <Area dataKey="over" type="linear" stroke="none" fill={colors.overFill} fillOpacity={1} activeDot={false} isAnimationActive={false} />
              <Area dataKey="under" type="linear" stroke="none" fill={colors.underFill} fillOpacity={1} activeDot={false} isAnimationActive={false} />
              {drag && Math.abs(drag.b - drag.a) > 0 && (
                <ReferenceArea
                  x1={Math.min(drag.a, drag.b)}
                  x2={Math.max(drag.a, drag.b) + HALF_HOUR}
                  fill={colors.forecast}
                  fillOpacity={0.1}
                  stroke={colors.forecast}
                  strokeOpacity={0.6}
                  strokeDasharray="4 3"
                />
              )}
              <Tooltip
                content={tooltip}
                cursor={{ stroke: colors.text, strokeWidth: 1, strokeDasharray: "3 3" }}
                isAnimationActive={false}
              />
              <Line
                dataKey="actual"
                stroke={colors.actual}
                strokeWidth={2}
                strokeLinejoin="round"
                dot={false}
                activeDot={{ r: 5, fill: colors.actual, stroke: colors.surface, strokeWidth: 2 }}
                connectNulls={false}
                isAnimationActive={false}
              />
              <Line
                dataKey="forecastLine"
                stroke={colors.forecast}
                strokeWidth={2}
                strokeLinejoin="round"
                dot={(p: { cx?: number; cy?: number; payload?: Row; index?: number }) =>
                  !dense && p.payload?.forecast != null && p.cx != null && p.cy != null ? (
                    <circle key={p.index} cx={p.cx} cy={p.cy} r={3} fill={colors.surface} stroke={colors.forecast} strokeWidth={1.75} />
                  ) : (
                    <g key={p.index} />
                  )
                }
                activeDot={{ r: 5, fill: colors.forecast, stroke: colors.surface, strokeWidth: 2 }}
                connectNulls={false}
                isAnimationActive={false}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>

        {errors.length > 0 && (
          <>
            <div className="subchart-label">
              <span>Error, forecast − actual (MW)</span>
              <span className="subchart-key">
                <span><span className="swatch swatch--over-solid" aria-hidden="true" /> Too high: under-bought</span>
                <span><span className="swatch swatch--under-solid" aria-hidden="true" /> Too low: over-bought</span>
              </span>
            </div>
            <div className="chart" style={{ height: 120 }}>
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={visible} syncId={syncId} margin={{ ...MARGIN, top: 6 }} onClick={handleClick}>
                  <CartesianGrid stroke={colors.grid} strokeDasharray="2 4" vertical={false} />
                  <XAxis dataKey="t" type="number" scale="time" domain={[domainStart, domainEnd]} ticks={ticks} hide allowDataOverflow />
                  <YAxis
                    tickFormatter={fmtNum}
                    tick={axisTick(colors)}
                    axisLine={false}
                    tickLine={false}
                    width={Y_AXIS_WIDTH}
                    domain={errDomain}
                    ticks={errTicks}
                    interval={0}
                    allowDataOverflow
                  />
                  <ReferenceLine y={0} stroke={colors.axis} />
                  <Tooltip content={() => null} cursor={{ fill: colors.highlight }} isAnimationActive={false} />
                  {dense && (
                    <Area dataKey="errOver" type="step" baseValue={0} connectNulls stroke="none" fill={colors.forecast} fillOpacity={0.5} activeDot={false} isAnimationActive={false} />
                  )}
                  {dense && (
                    <Area dataKey="errUnder" type="step" baseValue={0} connectNulls stroke="none" fill={colors.actual} fillOpacity={0.55} activeDot={false} isAnimationActive={false} />
                  )}
                  {!dense && (
                    <Bar dataKey="error" radius={[3, 3, 3, 3]} maxBarSize={16} isAnimationActive={false}>
                      {visible.map((r) => (
                        <Cell key={r.t} fill={(r.error ?? 0) >= 0 ? colors.forecast : colors.actual} fillOpacity={0.85} />
                      ))}
                    </Bar>
                  )}
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </>
        )}
      </div>

      <div className="overview" aria-label="Zoom slider: drag the handles to choose the visible time range">
        <ResponsiveContainer width="100%" height={48}>
          <ComposedChart data={rows} margin={{ top: 0, right: MARGIN.right, bottom: 0, left: MARGIN.left + Y_AXIS_WIDTH }}>
            <XAxis dataKey="t" hide />
            <Brush
              key={brushKey}
              dataKey="t"
              height={44}
              startIndex={s}
              endIndex={e}
              travellerWidth={12}
              traveller={(p: { x: number; y: number; width: number; height: number }) => <Traveller {...p} />}
              stroke={colors.axis}
              fill={colors.surface}
              tickFormatter={(t: number) => (mode === "day" ? fmtTime(iso(t)) : fmtShortDateTime(iso(t)))}
              onChange={(r: { startIndex?: number; endIndex?: number }) => {
                if (r.startIndex == null || r.endIndex == null) return;
                setRange(r.startIndex === 0 && r.endIndex === n - 1 ? null : [r.startIndex, r.endIndex]);
              }}
            >
              <ComposedChart data={rows}>
                <YAxis hide domain={[0, "auto"]} />
                <Area dataKey="over" type="linear" stroke="none" fill={colors.overFill} fillOpacity={1} isAnimationActive={false} />
                <Line dataKey="actual" stroke={colors.actual} strokeWidth={1} strokeOpacity={0.8} dot={false} isAnimationActive={false} />
                <Line dataKey="forecastLine" stroke={colors.forecast} strokeWidth={1} strokeOpacity={0.8} dot={false} isAnimationActive={false} />
              </ComposedChart>
            </Brush>
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <p className="zoom-hint muted">
        <span className="hint-fine">
          Drag across the chart to zoom · pinch or ⌘/Ctrl + scroll zooms at the pointer · swipe sideways to pan · click a point for its forecast history
        </span>
        <span className="hint-coarse">Use the buttons or the slider to zoom and pan · tap a point for its forecast history</span>
      </p>
    </div>
  );
}
