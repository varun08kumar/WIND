from datetime import date

from app.config import Settings


def test_vercel_environment_enables_serverless_mode(monkeypatch):
    monkeypatch.setenv("VERCEL", "1")
    assert Settings().serverless


def test_unpooled_database_url_is_preferred(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "postgres://u:p@pooler.example/db")
    monkeypatch.setenv("DATABASE_URL_UNPOOLED", "postgres://u:p@direct.example/db")
    assert Settings().database_url == "postgresql+psycopg://u:p@direct.example/db"


def test_default_range_falls_back_to_the_whole_range():
    settings = Settings(data_start_date=date(2026, 1, 1), data_end_date=date(2026, 1, 31))
    assert settings.default_range() == (date(2026, 1, 1), date(2026, 1, 31))


def test_default_range_is_clamped_inside_the_data_range():
    settings = Settings(
        data_start_date=date(2026, 1, 1), data_end_date=date(2026, 1, 31),
        default_start_date=date(2025, 12, 1), default_end_date=date(2026, 3, 1),
    )
    assert settings.default_range() == (date(2026, 1, 1), date(2026, 1, 31))
