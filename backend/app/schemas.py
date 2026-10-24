"""Response models. Timestamps are serialised as ISO-8601 in UTC (``Z``)."""

from datetime import date, datetime
from typing import Dict, List, Optional

from pydantic import BaseModel, Field


class DecisionRule(BaseModel):
    description: str
    cutoff_local_time: str = Field(description="HH:MM in the market timezone")
    days_before_delivery: int
    timezone: str


class MetaResponse(BaseModel):
    decision_rule: DecisionRule
    data_start_date: date
    data_end_date: date
    actual_resolution_minutes: int
    forecast_resolution_minutes: int
    sources: Dict[str, str]


class AccuracySummaryOut(BaseModel):
    mae_mw: Optional[float]
    rmse_mw: Optional[float]
    bias_mw: Optional[float] = Field(description="Mean of forecast minus actual; positive = over-forecast")
    p90_abs_error_mw: Optional[float]
    mean_actual_mw: Optional[float]
    mae_pct_of_mean_actual: Optional[float]
    matched_intervals: int
    forecast_intervals: int = Field(description="Intervals where a forecast point is expected (hourly)")
    coverage_pct: Optional[float] = Field(description="matched_intervals / forecast_intervals x 100")
    total_half_hour_intervals: int
    missing_forecast: int
    missing_actual: int
    missing_both: int
    no_forecast_point: int = Field(description="Half-hour intervals between hourly WINDFOR points")


class IntervalOut(BaseModel):
    start_time: datetime
    end_time: datetime
    actual_mw: Optional[int]
    forecast_mw: Optional[int]
    forecast_publish_time: Optional[datetime]
    lead_time_hours: Optional[float]
    error_mw: Optional[int] = Field(description="forecast_mw - actual_mw")
    status: str


class DeliveryDayResponse(BaseModel):
    delivery_date: date
    timezone: str
    decision_rule: DecisionRule
    decision_cutoff: datetime
    forecast_publish_times: List[datetime]
    summary: AccuracySummaryOut
    intervals: List[IntervalOut]


class SeriesResponse(BaseModel):
    from_date: date = Field(serialization_alias="from")
    to_date: date = Field(serialization_alias="to")
    timezone: str
    decision_rule: DecisionRule
    intervals: List[IntervalOut]


class VintageOut(BaseModel):
    publish_time: datetime
    generation_mw: int
    lead_time_hours: float
    available_at_decision: bool
    selected: bool
    error_mw: Optional[int]


class VintagesResponse(BaseModel):
    start_time: datetime
    delivery_date: date
    decision_cutoff: datetime
    actual_mw: Optional[int]
    selected_publish_time: Optional[datetime]
    vintages: List[VintageOut]


class DailyAccuracyOut(BaseModel):
    delivery_date: date
    decision_cutoff: datetime
    forecast_publish_times: List[datetime]
    summary: AccuracySummaryOut


class LeadTimeRange(BaseModel):
    min_hours: Optional[float]
    max_hours: Optional[float]


class AccuracyResponse(BaseModel):
    from_date: date = Field(serialization_alias="from")
    to_date: date = Field(serialization_alias="to")
    timezone: str
    decision_rule: DecisionRule
    decision_lead_time_hours: LeadTimeRange
    summary: AccuracySummaryOut
    daily: List[DailyAccuracyOut]


class LeadTimeBucketOut(BaseModel):
    min_hours: int
    max_hours: int
    count: int
    mae_mw: Optional[float]
    rmse_mw: Optional[float]
    bias_mw: Optional[float]


class LeadTimeResponse(BaseModel):
    from_date: date = Field(serialization_alias="from")
    to_date: date = Field(serialization_alias="to")
    analysis: str
    bucket_hours: int
    decision_lead_time_hours: LeadTimeRange
    vintages_evaluated: int
    excluded_non_positive_lead: int
    excluded_missing_actual: int
    buckets: List[LeadTimeBucketOut]


class IngestionRunOut(BaseModel):
    dataset: str
    finished_at: datetime
    fetched: int
    inserted: int
    updated: int
    unchanged: int
    skipped: int


class HealthResponse(BaseModel):
    status: str
    database: str
    actual_rows: Optional[int] = None
    forecast_rows: Optional[int] = None
    forecast_publishes: Optional[int] = None
    last_ingestion: List[IngestionRunOut] = []
