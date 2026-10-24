import type { AccuracySummary } from "../types/api";
import { fmtMw, fmtNum, fmtPct, fmtSignedMw } from "../lib/format";

interface Props {
  summary: AccuracySummary;
  showExtended?: boolean;
}

function biasNote(bias: number | null): string {
  if (bias == null) return "No matched intervals";
  if (Math.abs(bias) < 1) return "No systematic offset";
  return bias > 0 ? "Forecast above actual on average" : "Forecast below actual on average";
}

export function StatCards({ summary, showExtended = false }: Props) {
  const s = summary;
  const missing = s.missing_forecast + s.missing_actual + s.missing_both;
  return (
    <dl className={showExtended ? "cards cards--six" : "cards"}>
      <div className="card">
        <dt>MAE</dt>
        <dd className="card__value">{fmtMw(s.mae_mw)}</dd>
        <dd className="card__note">
          Mean absolute error
          {s.mae_pct_of_mean_actual != null && ` · ${fmtPct(s.mae_pct_of_mean_actual)} of mean actual`}
        </dd>
      </div>
      <div className="card">
        <dt>RMSE</dt>
        <dd className="card__value">{fmtMw(s.rmse_mw)}</dd>
        <dd className="card__note">Root mean squared error; weights large misses</dd>
      </div>
      <div className="card">
        <dt>Bias (forecast − actual)</dt>
        <dd className="card__value">{fmtSignedMw(s.bias_mw)}</dd>
        <dd className="card__note">{biasNote(s.bias_mw)}</dd>
      </div>
      <div className="card">
        <dt>Coverage</dt>
        <dd className="card__value">{fmtPct(s.coverage_pct)}</dd>
        <dd className="card__note">
          {fmtNum(s.matched_intervals)} of {fmtNum(s.forecast_intervals)} hourly points matched
          {missing > 0 && (
            <span className="warn-text">
              {" "}
              · {s.missing_forecast + s.missing_both} without eligible forecast, {s.missing_actual + s.missing_both}{" "}
              without actual
            </span>
          )}
        </dd>
      </div>
      {showExtended && (
        <>
          <div className="card">
            <dt>90th percentile |error|</dt>
            <dd className="card__value">{fmtMw(s.p90_abs_error_mw)}</dd>
            <dd className="card__note">9 in 10 hours missed by less than this</dd>
          </div>
          <div className="card">
            <dt>Mean actual generation</dt>
            <dd className="card__value">{fmtMw(s.mean_actual_mw)}</dd>
            <dd className="card__note">Over matched hourly points</dd>
          </div>
        </>
      )}
    </dl>
  );
}
