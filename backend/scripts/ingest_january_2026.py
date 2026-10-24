"""Populate the database with Elexon FUELHH (WIND) actuals and WINDFOR forecasts.

Usage (from the backend/ directory):
    python -m scripts.ingest_january_2026                 # full January 2026
    python -m scripts.ingest_january_2026 --date 2026-01-15
    python -m scripts.ingest_january_2026 --from 2026-01-10 --to 2026-01-12

Safe to rerun: rows are upserted on their natural keys.
"""

import argparse
import logging
import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.config import get_settings  # noqa: E402
from app.database import SessionLocal, init_db  # noqa: E402
from app.elexon import ElexonError  # noqa: E402
from app.ingest import run_ingestion  # noqa: E402


def main() -> int:
    settings = get_settings()
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--date", type=date.fromisoformat, help="ingest a single UK delivery date")
    parser.add_argument("--from", dest="start", type=date.fromisoformat, default=settings.data_start_date)
    parser.add_argument("--to", dest="end", type=date.fromisoformat, default=settings.last_delivery_date())
    args = parser.parse_args()
    start, end = (args.date, args.date) if args.date else (args.start, args.end)
    if end < start:
        parser.error("--to must not be before --from")

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    log = logging.getLogger("ingest")
    if not init_db():
        log.error("Database unavailable; check DATABASE_URL")
        return 1

    log.info("Ingesting delivery dates %s to %s from %s", start, end, settings.elexon_base_url)
    with SessionLocal() as session:
        try:
            reports = run_ingestion(session, settings, start, end)
        except ElexonError as exc:
            log.error("Elexon request failed: %s", exc)
            return 2
    for report in reports:
        print(report.summary())
    return 0


if __name__ == "__main__":
    sys.exit(main())
