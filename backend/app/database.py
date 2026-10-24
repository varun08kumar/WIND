import logging
import time
from typing import Iterator

from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import NullPool

from .config import get_settings
from .models import Base

logger = logging.getLogger(__name__)

_settings = get_settings()
engine = create_engine(
    _settings.database_url,
    pool_pre_ping=True,
    connect_args={"options": "-c timezone=UTC"},
    **({"poolclass": NullPool} if _settings.serverless else {}),
)
SessionLocal = sessionmaker(bind=engine, expire_on_commit=False)


def get_session() -> Iterator[Session]:
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()


def init_db(attempts: int = 15, delay_seconds: float = 2.0) -> bool:
    """Create tables, waiting for the database to accept connections.

    Returns False instead of raising when the database stays unreachable, so the
    API can still start and report the problem through /api/health.
    """
    for attempt in range(1, attempts + 1):
        try:
            with engine.begin() as conn:
                conn.execute(text("SELECT 1"))
            Base.metadata.create_all(engine)
            return True
        except Exception as exc:  # noqa: BLE001 - any connection error is retried
            logger.warning("Database not ready (attempt %d/%d): %s", attempt, attempts, exc)
            if attempt < attempts:
                time.sleep(delay_seconds)
    logger.error("Database unavailable after %d attempts", attempts)
    return False
