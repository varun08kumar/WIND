"""Decision-time forecast selection and forecast/actual matching.

The single rule that defines "the forecast available when buying day-ahead" lives in
`decision_cutoff` + `select_decision_forecasts`. Everything else builds on it.
"""

from collections import defaultdict
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from typing import Dict, Iterable, List, Optional, Protocol, Tuple
from zoneinfo import ZoneInfo

from sqlalchemy import select
from sqlalchemy.orm import Session

from .config import Settings
from .models import ActualGeneration, ForecastGeneration

INTERVAL = timedelta(minutes=30)
FORECAST_RESOLUTION = timedelta(hours=1)

STATUS_MATCHED = "matched"
STATUS_MISSING_ACTUAL = "missing_actual"
STATUS_MISSING_FORECAST = "missing_forecast"
STATUS_MISSING_BOTH = "missing_both"
STATUS_NO_FORECAST_POINT = "no_forecast_point"


class Vintage(Protocol):
    start_time: datetime
    publish_time: datetime
    generation_mw: int


def delivery_day_bounds(day: date, tz_name: str) -> Tuple[datetime, datetime]:
    """UTC [start, end) of a local delivery day. 23, 24 or 25 hours long around DST changes."""
    tz = ZoneInfo(tz_name)
    start = datetime.combine(day, time(0), tzinfo=tz)
    end = datetime.combine(day + timedelta(days=1), time(0), tzinfo=tz)
    return start.astimezone(timezone.utc), end.astimezone(timezone.utc)


def half_hour_intervals(day: date, tz_name: str) -> List[datetime]:
    """UTC start times of every half-hour interval in the local day (46, 48 or 50)."""
    start, end = delivery_day_bounds(day, tz_name)
    count = int((end - start) / INTERVAL)
    return [start + i * INTERVAL for i in range(count)]


def is_forecast_point(start_time: datetime) -> bool:
    return start_time.minute == 0


def delivery_date_of(start_time: datetime, tz_name: str) -> date:
    return start_time.astimezone(ZoneInfo(tz_name)).date()


def decision_cutoff(delivery_date: date, settings: Settings) -> datetime:
    """Latest publish time (UTC) a forecast may have to count as available for buying.

    Default: 09:00 Europe/London on the day before delivery. Configured through
    DECISION_CUTOFF_LOCAL_TIME, DECISION_DAYS_BEFORE and MARKET_TIMEZONE.
    """
    decision_day = delivery_date - timedelta(days=settings.decision_days_before)
    local = datetime.combine(decision_day, settings.decision_cutoff_local_time, tzinfo=ZoneInfo(settings.market_timezone))
    return local.astimezone(timezone.utc)


def describe_cutoff_rule(settings: Settings) -> str:
    days = settings.decision_days_before
    day_text = {0: "on the delivery day", 1: "on the day before delivery"}.get(days, f"{days} days before delivery")
    return (
        f"Latest forecast published at or before {settings.decision_cutoff_local_time.strftime('%H:%M')} "
        f"{settings.market_timezone} time {day_text}"
    )


def select_decision_forecasts(vintages: Iterable[Vintage], cutoff: datetime) -> Dict[datetime, Vintage]:
    """For each target start time, the most recently published vintage with publish_time <= cutoff.

    Vintages published after the cutoff are never selected, even if they are the only
    ones available; such intervals are reported as missing a forecast instead.
    """
    chosen: Dict[datetime, Vintage] = {}
    for vintage in vintages:
        if vintage.publish_time > cutoff:
            continue
        current = chosen.get(vintage.start_time)
        if current is None or vintage.publish_time > current.publish_time:
            chosen[vintage.start_time] = vintage
    return chosen


@dataclass
class IntervalResult:
    start_time: datetime
    actual_mw: Optional[int]
    forecast_mw: Optional[int]
    forecast_publish_time: Optional[datetime]
    status: str

    @property
    def error_mw(self) -> Optional[int]:
        if self.actual_mw is None or self.forecast_mw is None:
            return None
        return self.forecast_mw - self.actual_mw

    @property
    def lead_time_hours(self) -> Optional[float]:
        if self.forecast_publish_time is None:
            return None
        return (self.start_time - self.forecast_publish_time).total_seconds() / 3600


@dataclass
class DeliveryDay:
    delivery_date: date
    cutoff: datetime
    intervals: List[IntervalResult]


def build_intervals(
    starts: List[datetime], actuals: Dict[datetime, int], chosen: Dict[datetime, Vintage]
) -> List[IntervalResult]:
    results = []
    for start in starts:
        actual = actuals.get(start)
        forecast = chosen.get(start)
        if forecast is not None:
            status = STATUS_MATCHED if actual is not None else STATUS_MISSING_ACTUAL
        elif not is_forecast_point(start):
            status = STATUS_NO_FORECAST_POINT
        else:
            status = STATUS_MISSING_FORECAST if actual is not None else STATUS_MISSING_BOTH
        results.append(
            IntervalResult(
                start_time=start,
                actual_mw=actual,
                forecast_mw=forecast.generation_mw if forecast else None,
                forecast_publish_time=forecast.publish_time if forecast else None,
                status=status,
            )
        )
    return results


def load_delivery_days(session: Session, first: date, last: date, settings: Settings) -> List[DeliveryDay]:
    """Decision-time forecasts matched to actuals for every delivery date in [first, last]."""
    tz = settings.market_timezone
    range_start, _ = delivery_day_bounds(first, tz)
    _, range_end = delivery_day_bounds(last, tz)

    actual_rows = session.execute(
        select(ActualGeneration.start_time, ActualGeneration.generation_mw).where(
            ActualGeneration.fuel_type == "WIND",
            ActualGeneration.start_time >= range_start,
            ActualGeneration.start_time < range_end,
        )
    ).all()
    actuals = {row.start_time: row.generation_mw for row in actual_rows}

    forecast_rows = session.scalars(
        select(ForecastGeneration).where(
            ForecastGeneration.start_time >= range_start,
            ForecastGeneration.start_time < range_end,
            ForecastGeneration.publish_time <= decision_cutoff(last, settings),
        )
    ).all()
    by_day: Dict[date, List[ForecastGeneration]] = defaultdict(list)
    for row in forecast_rows:
        by_day[delivery_date_of(row.start_time, tz)].append(row)

    days = []
    day = first
    while day <= last:
        cutoff = decision_cutoff(day, settings)
        chosen = select_decision_forecasts(by_day.get(day, []), cutoff)
        days.append(DeliveryDay(day, cutoff, build_intervals(half_hour_intervals(day, tz), actuals, chosen)))
        day += timedelta(days=1)
    return days


def load_vintages(session: Session, start_time: datetime) -> List[ForecastGeneration]:
    return list(
        session.scalars(
            select(ForecastGeneration)
            .where(ForecastGeneration.start_time == start_time)
            .order_by(ForecastGeneration.publish_time)
        )
    )


def load_actual(session: Session, start_time: datetime) -> Optional[int]:
    return session.scalar(
        select(ActualGeneration.generation_mw).where(
            ActualGeneration.fuel_type == "WIND", ActualGeneration.start_time == start_time
        )
    )
