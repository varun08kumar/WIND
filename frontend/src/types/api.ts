
export interface DecisionRule {
  description: string;
  cutoff_local_time: string;
  days_before_delivery: number;
  timezone: string;
}

export interface Meta {
  decision_rule: DecisionRule;
  data_start_date: string;
  data_end_date: string;
  actual_resolution_minutes: number;
  forecast_resolution_minutes: number;
  sources: Record<string, string>;
}

export interface AccuracySummary {
  mae_mw: number | null;
  rmse_mw: number | null;
  bias_mw: number | null;
  p90_abs_error_mw: number | null;
  mean_actual_mw: number | null;
  mae_pct_of_mean_actual: number | null;
  matched_intervals: number;
  forecast_intervals: number;
  coverage_pct: number | null;
  total_half_hour_intervals: number;
  missing_forecast: number;
  missing_actual: number;
  missing_both: number;
  no_forecast_point: number;
}

export type IntervalStatus =
  | "matched"
  | "missing_actual"
  | "missing_forecast"
  | "missing_both"
  | "no_forecast_point";

export interface Interval {
  start_time: string;
  end_time: string;
  actual_mw: number | null;
  forecast_mw: number | null;
  forecast_publish_time: string | null;
  lead_time_hours: number | null;
  error_mw: number | null;
  status: IntervalStatus;
}

export interface DeliveryDay {
  delivery_date: string;
  timezone: string;
  decision_rule: DecisionRule;
  decision_cutoff: string;
  forecast_publish_times: string[];
  summary: AccuracySummary;
  intervals: Interval[];
}

export interface Series {
  from: string;
  to: string;
  timezone: string;
  decision_rule: DecisionRule;
  intervals: Interval[];
}

export interface Vintage {
  publish_time: string;
  generation_mw: number;
  lead_time_hours: number;
  available_at_decision: boolean;
  selected: boolean;
  error_mw: number | null;
}

export interface Vintages {
  start_time: string;
  delivery_date: string;
  decision_cutoff: string;
  actual_mw: number | null;
  selected_publish_time: string | null;
  vintages: Vintage[];
}

export interface LeadTimeRange {
  min_hours: number | null;
  max_hours: number | null;
}

export interface DailyAccuracy {
  delivery_date: string;
  decision_cutoff: string;
  forecast_publish_times: string[];
  summary: AccuracySummary;
}

export interface Accuracy {
  from: string;
  to: string;
  timezone: string;
  decision_rule: DecisionRule;
  decision_lead_time_hours: LeadTimeRange;
  summary: AccuracySummary;
  daily: DailyAccuracy[];
}

export interface LeadTimeBucket {
  min_hours: number;
  max_hours: number;
  count: number;
  mae_mw: number | null;
  rmse_mw: number | null;
  bias_mw: number | null;
}

export interface LeadTime {
  from: string;
  to: string;
  analysis: string;
  bucket_hours: number;
  decision_lead_time_hours: LeadTimeRange;
  vintages_evaluated: number;
  excluded_non_positive_lead: number;
  excluded_missing_actual: number;
  buckets: LeadTimeBucket[];
}
