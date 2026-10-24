"""Application settings, read from environment variables (or a local .env file)."""

from datetime import date, datetime, time, timedelta
from functools import lru_cache
from typing import List, Optional, Tuple
from zoneinfo import ZoneInfo

from pydantic import AliasChoices, Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=("../.env", ".env"), extra="ignore")

    database_url: str = Field(
        default="postgresql+psycopg://reint:reint@localhost:5432/reint",
        validation_alias=AliasChoices("DATABASE_URL_UNPOOLED", "DATABASE_URL"),
    )
    serverless: bool = Field(default=False, validation_alias=AliasChoices("SERVERLESS", "VERCEL"))

    elexon_base_url: str = "https://data.elexon.co.uk/bmrs/api/v1"
    elexon_timeout_seconds: float = 60.0
    elexon_max_retries: int = 4
    elexon_window_days: int = 7

    decision_cutoff_local_time: time = time(9, 0)
    decision_days_before: int = 1
    market_timezone: str = "Europe/London"

    data_start_date: date = date(2026, 1, 1)
    data_end_date: date = date(2026, 1, 31)
    live_mode: bool = False
    default_start_date: Optional[date] = None
    default_end_date: Optional[date] = None

    cors_origins: str = "http://localhost:5173,http://localhost:8080"
    frontend_dist_dir: str = ""

    @field_validator("database_url")
    @classmethod
    def _normalise_database_url(cls, value: str) -> str:
        if value.startswith("postgres://"):
            value = "postgresql://" + value[len("postgres://"):]
        if value.startswith("postgresql://"):
            value = "postgresql+psycopg://" + value[len("postgresql://"):]
        return value

    def last_delivery_date(self) -> date:
        """Last delivery date the product covers: DATA_END_DATE, or in live mode the day being bought now."""
        if self.live_mode:
            today = datetime.now(ZoneInfo(self.market_timezone)).date()
            return today + timedelta(days=self.decision_days_before)
        return self.data_end_date

    def default_range(self) -> Tuple[date, date]:
        """Dates the dashboard opens on: DEFAULT_START_DATE..DEFAULT_END_DATE, else the whole range."""
        first, last = self.data_start_date, self.last_delivery_date()
        start = min(max(self.default_start_date or first, first), last)
        end = min(max(self.default_end_date or last, start), last)
        return start, end

    @property
    def cors_origin_list(self) -> List[str]:
        return [origin.strip() for origin in self.cors_origins.split(",") if origin.strip()]

    @field_validator("decision_days_before")
    @classmethod
    def _non_negative(cls, value: int) -> int:
        if value < 0:
            raise ValueError("DECISION_DAYS_BEFORE must be >= 0")
        return value


@lru_cache
def get_settings() -> Settings:
    return Settings()
