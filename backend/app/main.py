import logging
from contextlib import asynccontextmanager
from datetime import date, datetime, timezone
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import distinct, func, select, text
from sqlalchemy.orm import Session

from . import schemas
from .config import Settings, get_settings
from .database import get_session, init_db
from .forecasts import (
    FORECAST_RESOLUTION,
    INTERVAL,
    IntervalResult,
    decision_cutoff,
    delivery_date_of,
    describe_cutoff_rule,
    load_actual,
    load_delivery_days,
    load_vintages,
    select_decision_forecasts,
)
from .metrics import AccuracySummary, decision_lead_time_range, lead_time_accuracy, summarize, unique_publish_times
from .models import ActualGeneration, ForecastGeneration, IngestionRun

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(_: FastAPI):
    if not init_db(attempts=1 if get_settings().serverless else 15):
        logger.error("Starting without a database connection; /api/health will report it")
    yield


app = FastAPI(
    title="Wind Forecast Decision Monitor",
    description="Elexon WINDFOR forecasts available at day-ahead decision time, evaluated against FUELHH wind outturn.",
    version="1.0.0",
    lifespan=lifespan,
)
app.add_middleware(
    CORSMiddleware, allow_origins=get_settings().cors_origin_list, allow_methods=["GET"], allow_headers=["*"]
)


@app.exception_handler(RequestValidationError)
async def validation_error(_: Request, exc: RequestValidationError):
    """Flatten FastAPI's validation errors into one readable message."""
    messages = [f"'{err['loc'][-1]}': {err['msg']}" for err in exc.errors()]
    return JSONResponse(status_code=422, content={"detail": "; ".join(messages), "errors": exc.errors()})


def decision_rule(settings: Settings) -> schemas.DecisionRule:
    return schemas.DecisionRule(
        description=describe_cutoff_rule(settings),
        cutoff_local_time=settings.decision_cutoff_local_time.strftime("%H:%M"),
        days_before_delivery=settings.decision_days_before,
        timezone=settings.market_timezone,
    )


def check_date_in_range(value: date, settings: Settings, name: str) -> None:
    last = settings.last_delivery_date()
    if not settings.data_start_date <= value <= last:
        raise HTTPException(
            status_code=422,
            detail=(
                f"'{name}' must be a delivery date between {settings.data_start_date} and "
                f"{last} (UK local), got {value}."
            ),
        )


def summary_out(summary: AccuracySummary) -> schemas.AccuracySummaryOut:
    stats = summary.stats
    return schemas.AccuracySummaryOut(
        mae_mw=stats.mae_mw,
        rmse_mw=stats.rmse_mw,
        bias_mw=stats.bias_mw,
        p90_abs_error_mw=stats.p90_abs_error_mw,
        mean_actual_mw=stats.mean_actual_mw,
        mae_pct_of_mean_actual=stats.mae_pct_of_mean_actual,
        matched_intervals=summary.matched,
        forecast_intervals=summary.forecast_intervals,
        coverage_pct=summary.coverage_pct,
        total_half_hour_intervals=summary.total_intervals,
        missing_forecast=summary.missing_forecast,
        missing_actual=summary.missing_actual,
        missing_both=summary.missing_both,
        no_forecast_point=summary.no_forecast_point,
    )


def interval_out(i: IntervalResult) -> schemas.IntervalOut:
    return schemas.IntervalOut(
        start_time=i.start_time,
        end_time=i.start_time + INTERVAL,
        actual_mw=i.actual_mw,
        forecast_mw=i.forecast_mw,
        forecast_publish_time=i.forecast_publish_time,
        lead_time_hours=i.lead_time_hours,
        error_mw=i.error_mw,
        status=i.status,
    )


@app.get("/api/health", response_model=schemas.HealthResponse)
def health(session: Session = Depends(get_session)):
    try:
        session.execute(text("SELECT 1"))
        actual_rows = session.scalar(select(func.count()).select_from(ActualGeneration))
        forecast_rows = session.scalar(select(func.count()).select_from(ForecastGeneration))
        publishes = session.scalar(select(func.count(distinct(ForecastGeneration.publish_time))))
        runs = session.scalars(select(IngestionRun).order_by(IngestionRun.finished_at.desc()).limit(2)).all()
    except Exception as exc:  # noqa: BLE001 - report any database failure
        logger.warning("Health check database error: %s", exc)
        return JSONResponse(status_code=503, content={"status": "error", "database": "unavailable"})
    return schemas.HealthResponse(
        status="ok",
        database="ok",
        actual_rows=actual_rows,
        forecast_rows=forecast_rows,
        forecast_publishes=publishes,
        last_ingestion=[
            schemas.IngestionRunOut(
                dataset=r.dataset, finished_at=r.finished_at, fetched=r.fetched, inserted=r.inserted,
                updated=r.updated, unchanged=r.unchanged, skipped=r.skipped,
            )
            for r in runs
        ],
    )


@app.get("/api/meta", response_model=schemas.MetaResponse)
def meta(settings: Settings = Depends(get_settings)):
    return schemas.MetaResponse(
        decision_rule=decision_rule(settings),
        data_start_date=settings.data_start_date,
        data_end_date=settings.last_delivery_date(),
        actual_resolution_minutes=int(INTERVAL.total_seconds() // 60),
        forecast_resolution_minutes=int(FORECAST_RESOLUTION.total_seconds() // 60),
        sources={
            "actual": "Elexon BMRS FUELHH (fuelType WIND)",
            "forecast": "Elexon BMRS WINDFOR",
        },
    )


@app.get("/api/forecasts/latest", response_model=schemas.DeliveryDayResponse)
def forecasts_latest(
    delivery_date: date = Query(..., alias="date", description="UK delivery date, YYYY-MM-DD"),
    session: Session = Depends(get_session),
    settings: Settings = Depends(get_settings),
):
    """Decision-time forecast vs actual for each half-hour of a UK delivery date."""
    check_date_in_range(delivery_date, settings, "date")
    day = load_delivery_days(session, delivery_date, delivery_date, settings)[0]
    return schemas.DeliveryDayResponse(
        delivery_date=day.delivery_date,
        timezone=settings.market_timezone,
        decision_rule=decision_rule(settings),
        decision_cutoff=day.cutoff,
        forecast_publish_times=unique_publish_times(day.intervals),
        summary=summary_out(summarize(day.intervals)),
        intervals=[interval_out(i) for i in day.intervals],
    )


@app.get("/api/forecasts/series", response_model=schemas.SeriesResponse, response_model_by_alias=True)
def forecast_series(
    from_date: date = Query(..., alias="from", description="First UK delivery date, YYYY-MM-DD"),
    to_date: date = Query(..., alias="to", description="Last UK delivery date (inclusive), YYYY-MM-DD"),
    session: Session = Depends(get_session),
    settings: Settings = Depends(get_settings),
):
    """Decision-time forecast vs actual for every half-hour across a range of delivery dates."""
    _date_range(from_date, to_date, settings)
    days = load_delivery_days(session, from_date, to_date, settings)
    return schemas.SeriesResponse(
        from_date=from_date,
        to_date=to_date,
        timezone=settings.market_timezone,
        decision_rule=decision_rule(settings),
        intervals=[interval_out(i) for day in days for i in day.intervals],
    )


@app.get("/api/forecasts/vintages", response_model=schemas.VintagesResponse)
def forecast_vintages(
    start_time: datetime = Query(..., description="Target interval start, ISO-8601 with offset, e.g. 2026-01-15T17:00:00Z"),
    session: Session = Depends(get_session),
    settings: Settings = Depends(get_settings),
):
    """Every stored forecast vintage for one target interval, ordered by publish time."""
    if start_time.tzinfo is None:
        raise HTTPException(422, "'start_time' must include a UTC offset, e.g. 2026-01-15T17:00:00Z.")
    start_time = start_time.astimezone(timezone.utc)
    if start_time.minute not in (0, 30) or start_time.second or start_time.microsecond:
        raise HTTPException(422, "'start_time' must be on a half-hour boundary.")
    delivery_date = delivery_date_of(start_time, settings.market_timezone)
    check_date_in_range(delivery_date, settings, "start_time")

    cutoff = decision_cutoff(delivery_date, settings)
    vintages = load_vintages(session, start_time)
    selected = select_decision_forecasts(vintages, cutoff).get(start_time)
    actual = load_actual(session, start_time)
    return schemas.VintagesResponse(
        start_time=start_time,
        delivery_date=delivery_date,
        decision_cutoff=cutoff,
        actual_mw=actual,
        selected_publish_time=selected.publish_time if selected else None,
        vintages=[
            schemas.VintageOut(
                publish_time=v.publish_time,
                generation_mw=v.generation_mw,
                lead_time_hours=(start_time - v.publish_time).total_seconds() / 3600,
                available_at_decision=v.publish_time <= cutoff,
                selected=selected is not None and v.publish_time == selected.publish_time,
                error_mw=None if actual is None else v.generation_mw - actual,
            )
            for v in vintages
        ],
    )


def _date_range(from_date: date, to_date: date, settings: Settings) -> None:
    check_date_in_range(from_date, settings, "from")
    check_date_in_range(to_date, settings, "to")
    if to_date < from_date:
        raise HTTPException(422, f"'to' ({to_date}) must not be before 'from' ({from_date}).")


@app.get("/api/accuracy", response_model=schemas.AccuracyResponse, response_model_by_alias=True)
def accuracy(
    from_date: date = Query(..., alias="from", description="First UK delivery date, YYYY-MM-DD"),
    to_date: date = Query(..., alias="to", description="Last UK delivery date (inclusive), YYYY-MM-DD"),
    session: Session = Depends(get_session),
    settings: Settings = Depends(get_settings),
):
    """Accuracy of decision-time forecasts over a range of delivery dates."""
    _date_range(from_date, to_date, settings)
    days = load_delivery_days(session, from_date, to_date, settings)
    all_intervals = [i for day in days for i in day.intervals]
    lead_min, lead_max = decision_lead_time_range(all_intervals)
    return schemas.AccuracyResponse(
        from_date=from_date,
        to_date=to_date,
        timezone=settings.market_timezone,
        decision_rule=decision_rule(settings),
        decision_lead_time_hours=schemas.LeadTimeRange(min_hours=lead_min, max_hours=lead_max),
        summary=summary_out(summarize(all_intervals)),
        daily=[
            schemas.DailyAccuracyOut(
                delivery_date=day.delivery_date,
                decision_cutoff=day.cutoff,
                forecast_publish_times=unique_publish_times(day.intervals),
                summary=summary_out(summarize(day.intervals)),
            )
            for day in days
        ],
    )


@app.get("/api/accuracy/lead-time", response_model=schemas.LeadTimeResponse, response_model_by_alias=True)
def accuracy_by_lead_time(
    from_date: date = Query(..., alias="from"),
    to_date: date = Query(..., alias="to"),
    bucket_hours: int = Query(6, ge=1, le=24),
    session: Session = Depends(get_session),
    settings: Settings = Depends(get_settings),
):
    """Retrospective: accuracy of all stored vintages by forecast horizon (ignores the decision cutoff)."""
    _date_range(from_date, to_date, settings)
    analysis = lead_time_accuracy(session, from_date, to_date, settings, bucket_hours)
    days = load_delivery_days(session, from_date, to_date, settings)
    lead_min, lead_max = decision_lead_time_range(i for day in days for i in day.intervals)
    return schemas.LeadTimeResponse(
        from_date=from_date,
        to_date=to_date,
        analysis="retrospective: every stored vintage, including those published after the decision cutoff",
        bucket_hours=bucket_hours,
        decision_lead_time_hours=schemas.LeadTimeRange(min_hours=lead_min, max_hours=lead_max),
        vintages_evaluated=analysis.vintages_evaluated,
        excluded_non_positive_lead=analysis.excluded_non_positive_lead,
        excluded_missing_actual=analysis.excluded_missing_actual,
        buckets=[
            schemas.LeadTimeBucketOut(
                min_hours=b.min_hours, max_hours=b.max_hours, count=b.stats.count,
                mae_mw=b.stats.mae_mw, rmse_mw=b.stats.rmse_mw, bias_mw=b.stats.bias_mw,
            )
            for b in analysis.buckets
        ],
    )


_dist = Path(get_settings().frontend_dist_dir) if get_settings().frontend_dist_dir else None
if _dist and _dist.is_dir():
    app.mount("/assets", StaticFiles(directory=_dist / "assets"), name="assets")

    @app.get("/{path:path}", include_in_schema=False)
    def spa(path: str):
        if path.startswith("api/"):
            raise HTTPException(404, "Not found")
        candidate = (_dist / path).resolve()
        if path and candidate.is_file() and _dist.resolve() in candidate.parents:
            return FileResponse(candidate)
        return FileResponse(_dist / "index.html")
