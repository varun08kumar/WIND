import { useEffect } from "react";
import { api, useResource } from "../api/client";
import type { Meta } from "../types/api";
import { addDays, fmtDateTime, fmtDay, fmtHours, ukDate, ukHour, ukZone } from "../lib/format";
import { clampDate, useQueryParams } from "../lib/urlState";
import { AccuracySection } from "../components/AccuracySection";
import { TimeSeriesChart } from "../components/TimeSeriesChart";
import { IntervalTable } from "../components/IntervalTable";
import { StatCards } from "../components/StatCards";
import { Empty, ErrorState, Loading } from "../components/States";
import { VintagePanel } from "../components/VintagePanel";

const DEFAULT_INTERVAL_HOUR = 17;

export function Dashboard({ meta }: { meta: Meta }) {
  const [params, setParams] = useQueryParams();
  const min = meta.data_start_date;
  const max = meta.data_end_date;
  const date = clampDate(params.get("date"), min, max, meta.default_to);
  const from = clampDate(params.get("from"), min, max, meta.default_from);
  const to = clampDate(params.get("to"), from, max, meta.default_to);
  const intervalParam = params.get("interval");

  const day = useResource(date, (s) => api.day(date, s));
  const dayData = day.data;

  const intervals = dayData?.intervals ?? [];
  const intervalInDay = intervals.find((i) => i.start_time === intervalParam && i.status !== "no_forecast_point");
  const fallbackInterval =
    intervals.find((i) => i.forecast_mw != null && ukHour(i.start_time) === DEFAULT_INTERVAL_HOUR) ??
    intervals.find((i) => i.forecast_mw != null);
  const selectedStart = dayData && dayData.delivery_date === date ? (intervalInDay ?? fallbackInterval)?.start_time ?? null : null;

  useEffect(() => {
    document.title = `${fmtDay(date)} · Wind Forecast Decision Monitor`;
  }, [date]);

  const setDate = (value: string) => setParams({ date: clampDate(value, min, max, date), interval: null });
  const selectInterval = (start: string) => setParams({ interval: start });
  const scrollToDay = () =>
    document.getElementById("day-heading")?.scrollIntoView({
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
    });

  const rule = meta.decision_rule;
  const publishTimes = dayData?.forecast_publish_times ?? [];
  const leads = intervals.map((i) => i.lead_time_hours).filter((v): v is number => v != null);

  return (
    <>
      <section className="section" aria-labelledby="day-heading">
        <div className="section__head">
          <h2 id="day-heading">Delivery Day</h2>
          <p className="muted">The wind forecast you could have used when buying day-ahead, against what the wind actually generated.</p>
        </div>

        <div className="controls" role="group" aria-label="Delivery date">
          <button type="button" className="btn" onClick={() => setDate(addDays(date, -1))} disabled={date <= min} aria-label="Previous delivery day">
            ← Prev
          </button>
          <label className="field">
            <span>Delivery date (UK)</span>
            <input type="date" name="date" min={min} max={max} value={date} autoComplete="off" onChange={(e) => e.target.value && setDate(e.target.value)} />
          </label>
          <button type="button" className="btn" onClick={() => setDate(addDays(date, 1))} disabled={date >= max} aria-label="Next delivery day">
            Next →
          </button>
        </div>

        {day.error && <ErrorState message={day.error} onRetry={day.retry} />}
        {!day.error && !dayData && <Loading label="Loading delivery day…" />}
        {dayData && (
          <div className={day.loading ? "is-refreshing" : undefined} aria-busy={day.loading}>
            <dl className="decision">
              <div>
                <dt>Delivery day</dt>
                <dd>{fmtDay(dayData.delivery_date)}</dd>
              </div>
              <div>
                <dt>Decision cutoff</dt>
                <dd>{fmtDateTime(dayData.decision_cutoff)}</dd>
              </div>
              <div>
                <dt>Forecast used (published)</dt>
                <dd>
                  {publishTimes.length ? publishTimes.map(fmtDateTime).join("; ") : <span className="warn-text">None published before the cutoff</span>}
                </dd>
              </div>
              <div>
                <dt>Forecast horizon</dt>
                <dd>{leads.length ? `${fmtHours(Math.min(...leads))} – ${fmtHours(Math.max(...leads))} ahead` : "—"}</dd>
              </div>
            </dl>
            <p className="rule">
              <strong>Decision rule:</strong> {rule.description}. Later revisions are never substituted; hours without an eligible forecast are flagged.
            </p>

            {dayData.summary.matched_intervals === 0 && dayData.summary.total_half_hour_intervals > 0 && intervals.every((i) => i.actual_mw == null && i.forecast_mw == null) ? (
              <Empty title={`No data stored for ${fmtDay(date)}.`}>
                Run <code>python -m scripts.ingest_january_2026 --date {date}</code> to load it.
              </Empty>
            ) : (
              <>
                <StatCards summary={dayData.summary} />
                <div className="panel">
                  <div className="panel__head">
                    <h3>Wind Generation, Forecast vs Actual (MW)</h3>
                    <ul className="legend" aria-label="Legend">
                      <li><span className="key key--forecast" aria-hidden="true" /> Forecast at decision time (WINDFOR, hourly)</li>
                      <li><span className="key key--actual" aria-hidden="true" /> Actual (FUELHH wind, half-hourly)</li>
                      <li><span className="swatch swatch--over" aria-hidden="true" /> Forecast above actual</li>
                      <li><span className="swatch swatch--under" aria-hidden="true" /> Forecast below actual</li>
                      {dayData.summary.missing_forecast + dayData.summary.missing_both > 0 && (
                        <li><span className="swatch swatch--missing" aria-hidden="true" /> No eligible forecast</li>
                      )}
                      <li><span className="swatch swatch--band" aria-hidden="true" /> Selected hour</li>
                    </ul>
                  </div>
                  <figure className="figure">
                    <TimeSeriesChart
                      mode="day"
                      intervals={intervals}
                      selectedStart={selectedStart}
                      onPick={(i) => selectInterval(i.start_time)}
                      pickHint="Click to see every forecast vintage for this hour"
                    />
                    <figcaption className="note">
                      Times in UK local time ({ukZone(dayData.intervals[0]?.start_time ?? dayData.decision_cutoff)}). Gaps in the actual line mean
                      outturn was not available. Click an hour, or use the table, to inspect its forecast vintages.
                    </figcaption>
                  </figure>
                  <details className="details">
                    <summary>All {intervals.length} half-hour intervals (table)</summary>
                    <IntervalTable intervals={intervals} selectedStart={selectedStart} onSelect={selectInterval} />
                  </details>
                </div>
                {selectedStart && <VintagePanel startTime={selectedStart} />}
              </>
            )}
          </div>
        )}
      </section>

      <AccuracySection
        meta={meta}
        from={from}
        to={to}
        selectedDate={date}
        onRangeChange={(f, t) => setParams({ from: f, to: t })}
        onSelectDay={(d) => {
          setDate(d);
          scrollToDay();
        }}
        onSelectInterval={(start) => {
          setParams({ date: ukDate(start), interval: start });
          scrollToDay();
        }}
      />
    </>
  );
}
