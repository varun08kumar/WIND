"""Forecast accuracy metrics. Error is always forecast minus actual, in MW.

MAPE is deliberately not reported: wind outturn can be close to zero, which makes
percentage errors unstable. MAE is also shown relative to mean actual generation,
which stays well defined.
"""

import math
from dataclasses import dataclass
from datetime import date, datetime
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

from sqlalchemy import select
from sqlalchemy.orm import Session

from .config import Settings
from .forecasts import (
    STATUS_MATCHED,
    STATUS_MISSING_ACTUAL,
    STATUS_MISSING_BOTH,
    STATUS_MISSING_FORECAST,
    STATUS_NO_FORECAST_POINT,
    IntervalResult,
    delivery_day_bounds,
)
from .models import ActualGeneration, ForecastGeneration


@dataclass
class ErrorStats:
    count: int
    mae_mw: Optional[float]
    rmse_mw: Optional[float]
    bias_mw: Optional[float]
    p90_abs_error_mw: Optional[float]
    mean_actual_mw: Optional[float]

    @property
    def mae_pct_of_mean_actual(self) -> Optional[float]:
        if self.mae_mw is None or not self.mean_actual_mw:
            return None
        return 100 * self.mae_mw / self.mean_actual_mw


def _percentile(sorted_values: Sequence[float], pct: float) -> float:
    """Linear-interpolated percentile of pre-sorted values."""
    if len(sorted_values) == 1:
        return sorted_values[0]
    rank = (len(sorted_values) - 1) * pct / 100
    low = math.floor(rank)
    high = math.ceil(rank)
    return sorted_values[low] + (sorted_values[high] - sorted_values[low]) * (rank - low)


def error_stats(pairs: Iterable[Tuple[float, float]]) -> ErrorStats:
    """Stats for (forecast, actual) pairs. Metrics are None when there are no pairs."""
    pairs = list(pairs)
    if not pairs:
        return ErrorStats(0, None, None, None, None, None)
    errors = [f - a for f, a in pairs]
    n = len(errors)
    return ErrorStats(
        count=n,
        mae_mw=sum(abs(e) for e in errors) / n,
        rmse_mw=math.sqrt(sum(e * e for e in errors) / n),
        bias_mw=sum(errors) / n,
        p90_abs_error_mw=_percentile(sorted(abs(e) for e in errors), 90),
        mean_actual_mw=sum(a for _, a in pairs) / n,
    )


@dataclass
class AccuracySummary:
    stats: ErrorStats
    total_intervals: int
    forecast_intervals: int
    matched: int
    missing_forecast: int
    missing_actual: int
    missing_both: int
    no_forecast_point: int

    @property
    def coverage_pct(self) -> Optional[float]:
        if not self.forecast_intervals:
            return None
        return 100 * self.matched / self.forecast_intervals


def summarize(intervals: Sequence[IntervalResult]) -> AccuracySummary:
    counts: Dict[str, int] = {}
    for interval in intervals:
        counts[interval.status] = counts.get(interval.status, 0) + 1
    no_point = counts.get(STATUS_NO_FORECAST_POINT, 0)
    stats = error_stats((i.forecast_mw, i.actual_mw) for i in intervals if i.status == STATUS_MATCHED)
    return AccuracySummary(
        stats=stats,
        total_intervals=len(intervals),
        forecast_intervals=len(intervals) - no_point,
        matched=counts.get(STATUS_MATCHED, 0),
        missing_forecast=counts.get(STATUS_MISSING_FORECAST, 0),
        missing_actual=counts.get(STATUS_MISSING_ACTUAL, 0),
        missing_both=counts.get(STATUS_MISSING_BOTH, 0),
        no_forecast_point=no_point,
    )


@dataclass
class LeadTimeBucket:
    min_hours: int
    max_hours: int
    stats: ErrorStats


@dataclass
class LeadTimeAnalysis:
    buckets: List[LeadTimeBucket]
    vintages_evaluated: int
    excluded_non_positive_lead: int
    excluded_missing_actual: int


def lead_time_accuracy(
    session: Session, first: date, last: date, settings: Settings, bucket_hours: int = 6
) -> LeadTimeAnalysis:
    """Retrospective accuracy of *every* stored vintage, grouped by lead time.

    This intentionally ignores the decision cutoff: it answers "how does accuracy
    change with forecast horizon?", not "what was available when buying".
    Lead time = target start time - publish time. Vintages published at or after
    the target start (WINDFOR publishes include a few already-elapsed hours) are
    excluded and counted.
    """
    range_start, _ = delivery_day_bounds(first, settings.market_timezone)
    _, range_end = delivery_day_bounds(last, settings.market_timezone)
    rows = session.execute(
        select(
            ForecastGeneration.start_time,
            ForecastGeneration.publish_time,
            ForecastGeneration.generation_mw,
            ActualGeneration.generation_mw.label("actual_mw"),
        )
        .outerjoin(
            ActualGeneration,
            (ActualGeneration.start_time == ForecastGeneration.start_time) & (ActualGeneration.fuel_type == "WIND"),
        )
        .where(ForecastGeneration.start_time >= range_start, ForecastGeneration.start_time < range_end)
    ).all()

    grouped: Dict[int, List[Tuple[float, float]]] = {}
    non_positive = missing_actual = evaluated = 0
    for start_time, publish_time, forecast_mw, actual_mw in rows:
        lead_hours = (start_time - publish_time).total_seconds() / 3600
        if lead_hours <= 0:
            non_positive += 1
            continue
        if actual_mw is None:
            missing_actual += 1
            continue
        evaluated += 1
        index = int(lead_hours // bucket_hours)
        grouped.setdefault(index, []).append((forecast_mw, actual_mw))

    buckets = [
        LeadTimeBucket(index * bucket_hours, (index + 1) * bucket_hours, error_stats(grouped[index]))
        for index in sorted(grouped)
    ]
    return LeadTimeAnalysis(buckets, evaluated, non_positive, missing_actual)


def decision_lead_time_range(intervals: Iterable[IntervalResult]) -> Tuple[Optional[float], Optional[float]]:
    leads = [i.lead_time_hours for i in intervals if i.lead_time_hours is not None]
    if not leads:
        return None, None
    return min(leads), max(leads)


def unique_publish_times(intervals: Iterable[IntervalResult]) -> List[datetime]:
    return sorted({i.forecast_publish_time for i in intervals if i.forecast_publish_time is not None})

