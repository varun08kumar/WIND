from app.config import Settings


def test_vercel_environment_enables_serverless_mode(monkeypatch):
    monkeypatch.setenv("VERCEL", "1")
    assert Settings().serverless


def test_unpooled_database_url_is_preferred(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "postgres://u:p@pooler.example/db")
    monkeypatch.setenv("DATABASE_URL_UNPOOLED", "postgres://u:p@direct.example/db")
    assert Settings().database_url == "postgresql+psycopg://u:p@direct.example/db"
