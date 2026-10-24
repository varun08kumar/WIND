import math
from datetime import datetime, timedelta, timezone

import pytest

from app.forecasts import STATUS_MATCHED, STATUS_MISSING_ACTUAL, STATUS_NO_FORECAST_POINT, IntervalResult
from app.metrics import error_stats, summarize


def test_error_stats_known_values():
    stats = error_stats([(110, 100), (180, 200), (330, 300)])
    assert stats.count == 3
    assert stats.mae_mw == pytest.approx(20)
    assert stats.rmse_mw == pytest.approx(math.sqrt((100 + 400 + 900) / 3))
    assert stats.bias_mw == pytest.approx(20 / 3)
    assert stats.mean_actual_mw == pytest.approx(200)
    assert stats.mae_pct_of_mean_actual == pytest.approx(10)


def test_error_stats_empty_returns_none_not_zero():
    stats = error_stats([])
    assert stats.count == 0
    assert stats.mae_mw is None and stats.rmse_mw is None and stats.bias_mw is None


def test_summary_counts_and_coverage():
    t0 = datetime(2026, 1, 15, tzinfo=timezone.utc)
    pub = t0 - timedelta(hours=16)
    intervals = [
        IntervalResult(t0, 100, 120, pub, STATUS_MATCHED),
        IntervalResult(t0 + timedelta(minutes=30), 100, None, None, STATUS_NO_FORECAST_POINT),
        IntervalResult(t0 + timedelta(hours=1), None, 90, pub, STATUS_MISSING_ACTUAL),
    ]
    summary = summarize(intervals)
    assert summary.total_intervals == 3
    assert summary.forecast_intervals == 2
    assert summary.matched == 1
    assert summary.missing_actual == 1
    assert summary.coverage_pct == pytest.approx(50)
    assert summary.stats.bias_mw == pytest.approx(20)
