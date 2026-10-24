"""Database tables. All timestamps are stored as UTC (timestamptz)."""

from datetime import date, datetime
from typing import Optional

from sqlalchemy import JSON, Date, DateTime, Integer, String, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

JsonType = JSON().with_variant(JSONB(), "postgresql")


class Base(DeclarativeBase):
    pass


class ActualGeneration(Base):
    """FUELHH half-hourly outturn for fuelType WIND. One row per target interval."""

    __tablename__ = "actual_generation"
    __table_args__ = (UniqueConstraint("fuel_type", "start_time", name="uq_actual_fuel_start"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    dataset: Mapped[str] = mapped_column(String(16), default="FUELHH")
    fuel_type: Mapped[str] = mapped_column(String(16))
    start_time: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    settlement_date: Mapped[Optional[date]] = mapped_column(Date)
    settlement_period: Mapped[Optional[int]] = mapped_column(Integer)
    publish_time: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    generation_mw: Mapped[int] = mapped_column(Integer)
    raw: Mapped[Optional[dict]] = mapped_column(JsonType)
    ingested_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class ForecastGeneration(Base):
    """WINDFOR forecast points. One row per (publish time, target time) vintage."""

    __tablename__ = "forecast_generation"
    __table_args__ = (
        UniqueConstraint("publish_time", "start_time", name="uq_forecast_publish_start"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    dataset: Mapped[str] = mapped_column(String(16), default="WINDFOR")
    start_time: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    publish_time: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    generation_mw: Mapped[int] = mapped_column(Integer)
    raw: Mapped[Optional[dict]] = mapped_column(JsonType)
    ingested_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class IngestionRun(Base):
    """Audit trail of ingestion runs, shown in /api/health."""

    __tablename__ = "ingestion_run"

    id: Mapped[int] = mapped_column(primary_key=True)
    dataset: Mapped[str] = mapped_column(String(16))
    window_start: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    window_end: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    fetched: Mapped[int] = mapped_column(Integer, default=0)
    inserted: Mapped[int] = mapped_column(Integer, default=0)
    updated: Mapped[int] = mapped_column(Integer, default=0)
    unchanged: Mapped[int] = mapped_column(Integer, default=0)
    skipped: Mapped[int] = mapped_column(Integer, default=0)
    outside_window: Mapped[int] = mapped_column(Integer, default=0)
    finished_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
