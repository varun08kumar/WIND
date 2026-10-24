from datetime import date, datetime, timezone

import httpx
import pytest

from app.elexon import ElexonClient, ElexonError, date_windows, parse_actual, parse_forecast, parse_utc


def test_parse_utc_accepts_z_and_offsets():
    assert parse_utc("2026-01-15T17:00:00Z") == datetime(2026, 1, 15, 17, tzinfo=timezone.utc)
    assert parse_utc("2026-07-15T18:00:00+01:00") == datetime(2026, 7, 15, 17, tzinfo=timezone.utc)


def test_parse_utc_rejects_naive_timestamps():
    with pytest.raises(ValueError):
        parse_utc("2026-01-15T17:00:00")


def test_parse_forecast_row():
    record = parse_forecast(
        {"dataset": "WINDFOR", "publishTime": "2026-01-14T07:30:00Z", "startTime": "2026-01-15T17:00:00Z", "generation": 8870}
    )
    assert record.generation_mw == 8870
    assert record.publish_time == datetime(2026, 1, 14, 7, 30, tzinfo=timezone.utc)


@pytest.mark.parametrize(
    "row",
    [
        {"dataset": "FUELHH", "startTime": "2026-01-15T17:00:00Z", "fuelType": "WIND", "generation": None},
        {"dataset": "FUELHH", "startTime": None, "fuelType": "WIND", "generation": 5},
        {"dataset": "FUELHH", "startTime": "2026-01-15T17:10:00Z", "fuelType": "WIND", "generation": 5},
        {"dataset": "FUELHH", "startTime": "2026-01-15T17:00:00Z", "generation": 5},
        {"dataset": "FUELINST", "startTime": "2026-01-15T17:00:00Z", "fuelType": "WIND", "generation": 5},
    ],
)
def test_parse_actual_rejects_malformed_rows(row):
    with pytest.raises(ValueError):
        parse_actual(row)


def test_date_windows_cover_range_without_gaps():
    windows = list(date_windows(date(2026, 1, 1), date(2026, 1, 15), 7))
    assert windows == [
        (date(2026, 1, 1), date(2026, 1, 7)),
        (date(2026, 1, 8), date(2026, 1, 14)),
        (date(2026, 1, 15), date(2026, 1, 15)),
    ]


def _client(handler) -> ElexonClient:
    return ElexonClient(
        "https://example.test/api", max_retries=2, backoff_seconds=0,
        http_client=httpx.Client(transport=httpx.MockTransport(handler)),
    )


def test_client_retries_transient_errors_then_succeeds():
    calls = []

    def handler(request):
        calls.append(request)
        if len(calls) < 3:
            return httpx.Response(503)
        return httpx.Response(200, json=[{"startTime": "2026-01-15T17:00:00Z"}])

    rows = _client(handler).fetch_windfor(
        datetime(2026, 1, 14, tzinfo=timezone.utc), datetime(2026, 1, 15, tzinfo=timezone.utc)
    )
    assert len(calls) == 3
    assert rows == [{"startTime": "2026-01-15T17:00:00Z"}]
    assert calls[0].url.params["publishDateTimeFrom"] == "2026-01-14T00:00:00Z"


def test_client_gives_up_after_bounded_retries():
    calls = []

    def handler(request):
        calls.append(request)
        return httpx.Response(429)

    with pytest.raises(ElexonError):
        _client(handler).fetch_fuelhh(date(2026, 1, 1), date(2026, 1, 2))
    assert len(calls) == 3


def test_client_does_not_retry_bad_requests():
    calls = []

    def handler(request):
        calls.append(request)
        return httpx.Response(400, text="bad parameter")

    with pytest.raises(ElexonError, match="400"):
        _client(handler).fetch_fuelhh(date(2026, 1, 1), date(2026, 1, 2))
    assert len(calls) == 1
