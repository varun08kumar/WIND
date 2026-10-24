"""End-to-end: mocked Elexon -> ingestion -> PostgreSQL -> FastAPI.

Runs only when TEST_DATABASE_URL points at a disposable PostgreSQL database.
"""

import os
from datetime import date

import httpx
import pytest

pytestmark = pytest.mark.skipif(not os.environ.get("TEST_DATABASE_URL"), reason="TEST_DATABASE_URL not set")

DAY = "2026-01-15"


def fake_elexon(request: httpx.Request) -> httpx.Response:
    if request.url.path.endswith("/FUELHH/stream"):
        if request.url.params["settlementDateFrom"] > DAY or request.url.params["settlementDateTo"] < DAY:
            return httpx.Response(200, json=[])
        rows = [
            {"dataset": "FUELHH", "publishTime": f"{DAY}T{h:02d}:{m:02d}:00Z", "startTime": f"{DAY}T{h:02d}:{m:02d}:00Z",
             "settlementDate": DAY, "settlementPeriod": h * 2 + m // 30 + 1, "fuelType": "WIND", "generation": 1000}
            for h in range(24) for m in (0, 30)
            if not (h == 5 and m == 0)
        ]
        rows.append({"dataset": "FUELHH", "startTime": None, "fuelType": "WIND", "generation": 1})
        return httpx.Response(200, json=rows)
    if request.url.path.endswith("/WINDFOR/stream"):
        if not request.url.params["publishDateTimeFrom"] <= "2026-01-14T07:30:00Z" <= request.url.params["publishDateTimeTo"]:
            return httpx.Response(200, json=[])
        early = [
            {"dataset": "WINDFOR", "publishTime": "2026-01-14T07:30:00Z", "startTime": f"{DAY}T{h:02d}:00:00Z", "generation": 1100}
            for h in range(24) if h != 6
        ]
        late = [
            {"dataset": "WINDFOR", "publishTime": "2026-01-14T09:30:00Z", "startTime": f"{DAY}T{h:02d}:00:00Z", "generation": 5000}
            for h in range(24)
        ]
        return httpx.Response(200, json=early + late)
    return httpx.Response(404)


@pytest.fixture(scope="module")
def api():
    from fastapi.testclient import TestClient

    from app.config import get_settings
    from app.database import SessionLocal, engine, init_db
    from app.elexon import ElexonClient
    from app.ingest import run_ingestion
    from app.main import app
    from app.models import Base

    Base.metadata.drop_all(engine)
    assert init_db(attempts=1)
    client = ElexonClient("https://example.test", backoff_seconds=0, http_client=httpx.Client(transport=httpx.MockTransport(fake_elexon)))
    with SessionLocal() as session:
        first = run_ingestion(session, get_settings(), date(2026, 1, 15), date(2026, 1, 15), client)
        second = run_ingestion(session, get_settings(), date(2026, 1, 15), date(2026, 1, 15), client)
    with TestClient(app) as test_client:
        yield test_client, first, second
    Base.metadata.drop_all(engine)


def test_ingestion_is_idempotent(api):
    _, first, second = api
    actuals, forecasts = first
    assert (actuals.inserted, actuals.skipped) == (47, 1)
    assert forecasts.inserted == 47
    assert all(r.inserted == 0 and r.updated == 0 for r in second)
    assert second[0].unchanged == 47


def test_latest_uses_only_pre_cutoff_forecasts(api):
    client, _, _ = api
    body = client.get("/api/forecasts/latest", params={"date": DAY}).json()
    assert body["decision_cutoff"] == "2026-01-14T09:00:00Z"
    assert body["forecast_publish_times"] == ["2026-01-14T07:30:00Z"]
    by_start = {i["start_time"]: i for i in body["intervals"]}
    assert by_start[f"{DAY}T00:00:00Z"]["forecast_mw"] == 1100
    assert by_start[f"{DAY}T06:00:00Z"]["status"] == "missing_forecast"
    assert by_start[f"{DAY}T05:00:00Z"]["status"] == "missing_actual"
    assert by_start[f"{DAY}T00:30:00Z"]["status"] == "no_forecast_point"
    summary = body["summary"]
    assert summary["matched_intervals"] == 22
    assert summary["forecast_intervals"] == 24
    assert summary["bias_mw"] == pytest.approx(100)
    assert summary["mae_mw"] == pytest.approx(100)


def test_vintages_flags_selected_and_late_revisions(api):
    client, _, _ = api
    body = client.get("/api/forecasts/vintages", params={"start_time": f"{DAY}T12:00:00Z"}).json()
    assert [v["publish_time"] for v in body["vintages"]] == ["2026-01-14T07:30:00Z", "2026-01-14T09:30:00Z"]
    assert [v["selected"] for v in body["vintages"]] == [True, False]
    assert [v["available_at_decision"] for v in body["vintages"]] == [True, False]


def test_accuracy_reports_missing_counts(api):
    client, _, _ = api
    body = client.get("/api/accuracy", params={"from": DAY, "to": DAY}).json()
    assert body["from"] == DAY and body["to"] == DAY
    assert body["summary"]["missing_forecast"] == 1
    assert body["summary"]["missing_actual"] == 1
    assert body["summary"]["coverage_pct"] == pytest.approx(100 * 22 / 24)


def test_out_of_range_date_is_rejected(api):
    client, _, _ = api
    response = client.get("/api/forecasts/latest", params={"date": "2026-02-01"})
    assert response.status_code == 422
    assert "2026-01-31" in response.json()["detail"]


def test_health_reports_database(api):
    client, _, _ = api
    body = client.get("/api/health").json()
    assert body["database"] == "ok"
    assert body["actual_rows"] == 47


def test_series_spans_range_with_statuses(api):
    client, _, _ = api
    body = client.get("/api/forecasts/series", params={"from": DAY, "to": DAY}).json()
    assert body["from"] == DAY
    assert len(body["intervals"]) == 48
    assert body["intervals"][0]["forecast_mw"] == 1100
