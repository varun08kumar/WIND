import type { Interval, IntervalStatus } from "../types/api";
import { fmtHours, fmtNum, fmtTime, fmtTimeZ, fmtSignedNum } from "../lib/format";

export const STATUS_LABEL: Record<IntervalStatus, string> = {
  matched: "Matched",
  missing_actual: "Actual missing",
  missing_forecast: "No eligible forecast",
  missing_both: "Forecast & actual missing",
  no_forecast_point: "Half-hour (no forecast point)",
};

export function StatusBadge({ status }: { status: IntervalStatus }) {
  return <span className={`badge badge--${status}`}>{STATUS_LABEL[status]}</span>;
}

interface Props {
  intervals: Interval[];
  selectedStart: string | null;
  onSelect: (startTime: string) => void;
}

export function IntervalTable({ intervals, selectedStart, onSelect }: Props) {
  return (
    <div className="table-wrap">
      <table className="table">
        <caption className="visually-hidden">Half-hourly forecast and actual wind generation, UK local time</caption>
        <thead>
          <tr>
            <th scope="col">Interval (UK)</th>
            <th scope="col" className="num">Forecast MW</th>
            <th scope="col" className="num">Actual MW</th>
            <th scope="col" className="num">Error MW</th>
            <th scope="col" className="num">Lead time</th>
            <th scope="col">Status</th>
            <th scope="col"><span className="visually-hidden">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          {intervals.map((i) => {
            const selected = i.start_time === selectedStart;
            return (
              <tr key={i.start_time} aria-current={selected ? "true" : undefined} className={selected ? "is-selected" : undefined}>
                <th scope="row" className="mono">
                  {fmtTime(i.start_time)}–{fmtTimeZ(i.end_time)}
                </th>
                <td className="num">{fmtNum(i.forecast_mw)}</td>
                <td className="num">{fmtNum(i.actual_mw)}</td>
                <td className="num">{fmtSignedNum(i.error_mw)}</td>
                <td className="num">{fmtHours(i.lead_time_hours)}</td>
                <td>
                  <StatusBadge status={i.status} />
                </td>
                <td>
                  {i.status !== "no_forecast_point" && (
                    <button
                      type="button"
                      className="btn btn--small"
                      onClick={() => onSelect(i.start_time)}
                      aria-label={`Show forecast vintages for ${fmtTimeZ(i.start_time)}`}
                      aria-pressed={selected}
                    >
                      Vintages
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
