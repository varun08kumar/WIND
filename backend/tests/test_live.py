from datetime import date, datetime, timezone

from app.config import Settings
from scripts.ingest_live import live_window


def test_live_window_covers_recent_days_up_to_the_day_being_bought():
    now = datetime(2026, 6, 30, 23, 30, tzinfo=timezone.utc)
    assert live_window(Settings(), now) == (date(2026, 6, 29), date(2026, 7, 2))


def test_last_delivery_date_is_fixed_unless_live():
    assert Settings(data_end_date=date(2026, 2, 28)).last_delivery_date() == date(2026, 2, 28)
    live = Settings(live_mode=True, decision_days_before=1)
    assert live.last_delivery_date() > date(2026, 2, 28)
