from dataclasses import dataclass
from datetime import date, datetime, time, timezone

from app.config import Settings
from app.forecasts import (
    STATUS_MATCHED,
    STATUS_MISSING_ACTUAL,
    STATUS_MISSING_BOTH,
    STATUS_MISSING_FORECAST,
    STATUS_NO_FORECAST_POINT,
    build_intervals,
    decision_cutoff,
    delivery_date_of,
    half_hour_intervals,
    select_decision_forecasts,
)

UTC = timezone.utc


@dataclass
class V:
    start_time: datetime
    publish_time: datetime
    generation_mw: int


def utc(*args) -> datetime:
    return datetime(*args, tzinfo=UTC)


def test_default_cutoff_is_0900_uk_on_previous_day_in_winter():
    assert decision_cutoff(date(2026, 1, 15), Settings()) == utc(2026, 1, 14, 9, 0)


def test_cutoff_follows_british_summer_time():
    assert decision_cutoff(date(2026, 4, 2), Settings()) == utc(2026, 4, 1, 8, 0)


def test_cutoff_is_configurable():
    settings = Settings(decision_cutoff_local_time=time(15, 30), decision_days_before=2)
    assert decision_cutoff(date(2026, 1, 15), settings) == utc(2026, 1, 13, 15, 30)


def test_local_day_lengths_across_dst_changes():
    tz = "Europe/London"
    assert len(half_hour_intervals(date(2026, 1, 15), tz)) == 48
    assert len(half_hour_intervals(date(2026, 3, 29), tz)) == 46
    assert len(half_hour_intervals(date(2026, 10, 25), tz)) == 50
    first = half_hour_intervals(date(2026, 7, 1), tz)[0]
    assert first == utc(2026, 6, 30, 23, 0)


def test_delivery_date_uses_uk_local_time():
    assert delivery_date_of(utc(2026, 6, 30, 23, 30), "Europe/London") == date(2026, 7, 1)
    assert delivery_date_of(utc(2026, 1, 15, 23, 30), "Europe/London") == date(2026, 1, 15)


def test_selection_picks_latest_vintage_at_or_before_cutoff():
    target = utc(2026, 1, 15, 12)
    cutoff = utc(2026, 1, 14, 9)
    vintages = [
        V(target, utc(2026, 1, 13, 22, 30), 100),
        V(target, utc(2026, 1, 14, 9, 0), 200),
        V(target, utc(2026, 1, 14, 7, 30), 150),
        V(target, utc(2026, 1, 14, 9, 30), 999),
    ]
    assert select_decision_forecasts(vintages, cutoff)[target].generation_mw == 200


def test_selection_never_falls_back_to_later_revision():
    target = utc(2026, 1, 15, 12)
    only_late = [V(target, utc(2026, 1, 14, 10, 30), 500)]
    assert select_decision_forecasts(only_late, utc(2026, 1, 14, 9)) == {}


def test_interval_statuses():
    starts = [utc(2026, 1, 15, 0, 0), utc(2026, 1, 15, 0, 30), utc(2026, 1, 15, 1), utc(2026, 1, 15, 2), utc(2026, 1, 15, 3)]
    pub = utc(2026, 1, 14, 7, 30)
    chosen = {starts[0]: V(starts[0], pub, 110), starts[3]: V(starts[3], pub, 90)}
    actuals = {starts[0]: 100, starts[1]: 105, starts[2]: 95}
    results = build_intervals(starts, actuals, chosen)
    assert [r.status for r in results] == [
        STATUS_MATCHED,
        STATUS_NO_FORECAST_POINT,
        STATUS_MISSING_FORECAST,
        STATUS_MISSING_ACTUAL,
        STATUS_MISSING_BOTH,
    ]
    assert results[0].error_mw == 10
    assert results[0].lead_time_hours == 16.5
    assert results[2].error_mw is None
