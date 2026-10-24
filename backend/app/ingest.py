"""Fetch Elexon data, validate it and upsert it into PostgreSQL idempotently."""

import logging
from dataclasses import asdict, dataclass
from datetime import date, datetime, timedelta
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple, TypeVar

from sqlalchemy import column, tuple_
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from .config import Settings
from .elexon import (
    ActualRecord,
    ElexonClient,
    ForecastRecord,
    date_windows,
    datetime_windows,
    parse_actual,
    parse_forecast,
)
from .forecasts import delivery_day_bounds
from .models import ActualGeneration, ForecastGeneration, IngestionRun

logger = logging.getLogger(__name__)

T = TypeVar("T")

FORECAST_LOOKBACK_DAYS = 3
BATCH_SIZE = 1000


@dataclass
class IngestReport:
    dataset: str
    window_start: datetime
    window_end: datetime
    fetched: int = 0
    inserted: int = 0
    updated: int = 0
    unchanged: int = 0
    skipped: int = 0
    outside_window: int = 0

    def summary(self) -> str:
        return (
            f"{self.dataset}: fetched={self.fetched} inserted={self.inserted} updated={self.updated} "
            f"unchanged={self.unchanged} skipped={self.skipped} outside_window={self.outside_window}"
        )


def _validate(rows: Sequence[Dict[str, Any]], parse: Callable[[Dict[str, Any]], T], label: str) -> Tuple[List[T], int]:
    records, skipped = [], 0
    for row in rows:
        try:
            records.append(parse(row))
        except (ValueError, KeyError, TypeError) as exc:
            skipped += 1
            logger.warning("Skipping malformed %s row (%s): %r", label, exc, row)
    return records, skipped


def _upsert(session: Session, model, rows: List[Dict[str, Any]], key: List[str], compare: List[str]) -> Tuple[int, int]:
    """Insert or update rows on the natural key. Returns (inserted, updated).

    Rows whose compared columns are unchanged are left untouched, so a rerun
    reports them as unchanged instead of updated.
    """
    inserted = updated = 0
    table = model.__table__
    for i in range(0, len(rows), BATCH_SIZE):
        batch = rows[i : i + BATCH_SIZE]
        stmt = insert(table).values(batch)
        update_cols = {c: stmt.excluded[c] for c in batch[0] if c not in key}
        changed = tuple_(*[table.c[c] for c in compare]).is_distinct_from(
            tuple_(*[stmt.excluded[c] for c in compare])
        )
        stmt = stmt.on_conflict_do_update(index_elements=key, set_=update_cols, where=changed)
        stmt = stmt.returning((column("xmax") == 0).label("inserted"))
        for (was_inserted,) in session.execute(stmt):
            if was_inserted:
                inserted += 1
            else:
                updated += 1
    return inserted, updated


def _record_run(session: Session, report: IngestReport) -> None:
    session.add(IngestionRun(**asdict(report)))


def ingest_actuals(session: Session, client: ElexonClient, start: date, end: date, settings: Settings) -> IngestReport:
    """FUELHH WIND actuals for UK delivery dates [start, end]."""
    window_start, _ = delivery_day_bounds(start, settings.market_timezone)
    _, window_end = delivery_day_bounds(end, settings.market_timezone)
    report = IngestReport("FUELHH", window_start, window_end)

    by_key: Dict[datetime, ActualRecord] = {}
    for w_start, w_end in date_windows(start - timedelta(days=1), end + timedelta(days=1), settings.elexon_window_days):
        rows = client.fetch_fuelhh(w_start, w_end, fuel_type="WIND")
        logger.info("FUELHH %s..%s: %d rows", w_start, w_end, len(rows))
        report.fetched += len(rows)
        records, skipped = _validate(rows, parse_actual, "FUELHH")
        report.skipped += skipped
        for record in records:
            if record.fuel_type != "WIND":
                report.skipped += 1
                logger.warning("Skipping FUELHH row with fuelType %s", record.fuel_type)
                continue
            if window_start <= record.start_time < window_end:
                by_key[record.start_time] = record
            else:
                report.outside_window += 1

    values = [
        {
            "dataset": "FUELHH",
            "fuel_type": r.fuel_type,
            "start_time": r.start_time,
            "settlement_date": r.settlement_date,
            "settlement_period": r.settlement_period,
            "publish_time": r.publish_time,
            "generation_mw": r.generation_mw,
            "raw": r.raw,
        }
        for r in sorted(by_key.values(), key=lambda r: r.start_time)
    ]
    if values:
        report.inserted, report.updated = _upsert(
            session, ActualGeneration, values, key=["fuel_type", "start_time"],
            compare=["generation_mw", "publish_time", "settlement_date", "settlement_period"],
        )
    report.unchanged = len(values) - report.inserted - report.updated
    _record_run(session, report)
    session.commit()
    logger.info(report.summary())
    return report


def ingest_forecasts(session: Session, client: ElexonClient, start: date, end: date, settings: Settings) -> IngestReport:
    """WINDFOR vintages published from a few days before `start` to the end of `end`."""
    day_start, _ = delivery_day_bounds(start, settings.market_timezone)
    _, day_end = delivery_day_bounds(end, settings.market_timezone)
    publish_from = day_start - timedelta(days=FORECAST_LOOKBACK_DAYS)
    report = IngestReport("WINDFOR", publish_from, day_end)

    by_key: Dict[Tuple[datetime, datetime], ForecastRecord] = {}
    for w_start, w_end in datetime_windows(publish_from, day_end, settings.elexon_window_days):
        rows = client.fetch_windfor(w_start, w_end)
        logger.info("WINDFOR %s..%s: %d rows", w_start.isoformat(), w_end.isoformat(), len(rows))
        report.fetched += len(rows)
        records, skipped = _validate(rows, parse_forecast, "WINDFOR")
        report.skipped += skipped
        for record in records:
            by_key[(record.publish_time, record.start_time)] = record

    values = [
        {
            "dataset": "WINDFOR",
            "start_time": r.start_time,
            "publish_time": r.publish_time,
            "generation_mw": r.generation_mw,
            "raw": r.raw,
        }
        for r in sorted(by_key.values(), key=lambda r: (r.publish_time, r.start_time))
    ]
    if values:
        report.inserted, report.updated = _upsert(
            session, ForecastGeneration, values, key=["publish_time", "start_time"], compare=["generation_mw"],
        )
    report.unchanged = len(values) - report.inserted - report.updated
    _record_run(session, report)
    session.commit()
    logger.info(report.summary())
    return report


def run_ingestion(
    session: Session, settings: Settings, start: date, end: date, client: Optional[ElexonClient] = None
) -> List[IngestReport]:
    owns_client = client is None
    client = client or ElexonClient(
        settings.elexon_base_url,
        timeout_seconds=settings.elexon_timeout_seconds,
        max_retries=settings.elexon_max_retries,
    )
    try:
        return [
            ingest_actuals(session, client, start, end, settings),
            ingest_forecasts(session, client, start, end, settings),
        ]
    finally:
        if owns_client:
            client.close()
