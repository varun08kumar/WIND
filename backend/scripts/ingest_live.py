"""Keep the database current with the latest Elexon data (live mode).

Each cycle ingests UK delivery dates from a couple of days ago up to the day
being bought (tomorrow with the default 09:00 D-1 rule). That picks up every new
WINDFOR publish and each new or corrected FUELHH half-hour. Upserts make every
cycle safe to repeat, so overlapping windows cost nothing.

Usage (from the backend/ directory):
    python -m scripts.ingest_live                       # one cycle (cron / Heroku Scheduler)
    python -m scripts.ingest_live --loop                # worker: a cycle every 30 minutes
    python -m scripts.ingest_live --loop --every-minutes 15

Set LIVE_MODE=true for the API so the date range follows today.
"""

import argparse
import logging
import sys
import time
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Tuple
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlalchemy.exc import SQLAlchemyError  # noqa: E402

from app.config import Settings, get_settings  # noqa: E402
from app.database import SessionLocal, init_db  # noqa: E402
from app.elexon import ElexonError  # noqa: E402
from app.ingest import run_ingestion  # noqa: E402

LOOKBACK_DAYS = 2

log = logging.getLogger("ingest_live")


def live_window(settings: Settings, now: datetime) -> Tuple[date, date]:
    """Delivery dates to refresh: LOOKBACK_DAYS before today up to the day being bought."""
    today = now.astimezone(ZoneInfo(settings.market_timezone)).date()
    return today - timedelta(days=LOOKBACK_DAYS), today + timedelta(days=settings.decision_days_before)


def run_cycle(settings: Settings) -> bool:
    start, end = live_window(settings, datetime.now(ZoneInfo(settings.market_timezone)))
    log.info("Live ingestion for delivery dates %s to %s", start, end)
    try:
        with SessionLocal() as session:
            for report in run_ingestion(session, settings, start, end):
                print(report.summary(), flush=True)
        return True
    except (ElexonError, SQLAlchemyError) as exc:
        log.error("Live ingestion cycle failed: %s", exc)
        return False


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--loop", action="store_true", help="run forever instead of a single cycle")
    parser.add_argument("--every-minutes", type=float, default=30, help="minutes between cycles with --loop")
    args = parser.parse_args()
    if args.every_minutes <= 0:
        parser.error("--every-minutes must be positive")

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    settings = get_settings()
    if not init_db():
        log.error("Database unavailable; check DATABASE_URL")
        return 1

    if not args.loop:
        return 0 if run_cycle(settings) else 2

    log.info("Running every %s minutes; stop with Ctrl+C", args.every_minutes)
    try:
        while True:
            run_cycle(settings)
            time.sleep(args.every_minutes * 60)
    except KeyboardInterrupt:
        log.info("Stopped")
    return 0


if __name__ == "__main__":
    sys.exit(main())
