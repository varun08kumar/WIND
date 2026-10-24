"""Client for the Elexon BMRS Insights API (no API key required).

Verified against https://data.elexon.co.uk/swagger/v1/swagger.json and live calls:

* ``GET /datasets/FUELHH/stream`` filters by ``settlementDateFrom``/``settlementDateTo``
  (inclusive, yyyy-MM-dd) and ``fuelType``; rows are half-hourly.
* ``GET /datasets/WINDFOR/stream`` filters by ``publishDateTimeFrom``/``publishDateTimeTo``
  (both bounds inclusive); each publish holds ~73 hourly target points.
* Stream endpoints return a plain JSON array with no pagination, so large ranges are
  requested in fixed windows instead. Timestamps are UTC with a ``Z`` suffix.
* The spec documents 429 "Too many requests" without published limits, so 429/5xx and
  network errors are retried with exponential backoff (honouring ``Retry-After``).
"""

import logging
import time
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from typing import Any, Dict, Iterator, List, Optional, Tuple

import httpx

logger = logging.getLogger(__name__)

RETRYABLE_STATUS = {429, 500, 502, 503, 504}


class ElexonError(RuntimeError):
    pass


@dataclass(frozen=True)
class ActualRecord:
    start_time: datetime
    generation_mw: int
    fuel_type: str
    settlement_date: Optional[date]
    settlement_period: Optional[int]
    publish_time: Optional[datetime]
    raw: Dict[str, Any]


@dataclass(frozen=True)
class ForecastRecord:
    start_time: datetime
    publish_time: datetime
    generation_mw: int
    raw: Dict[str, Any]


def parse_utc(value: Any) -> datetime:
    """Parse an ISO-8601 timestamp that must carry a UTC offset; return it in UTC."""
    if not isinstance(value, str) or not value:
        raise ValueError(f"missing timestamp: {value!r}")
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError(f"timestamp has no UTC offset: {value!r}")
    return parsed.astimezone(timezone.utc)


def _parse_generation(value: Any) -> int:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"generation is not a number: {value!r}")
    return int(round(value))


def _check_interval_alignment(start: datetime) -> None:
    if start.minute not in (0, 30) or start.second or start.microsecond:
        raise ValueError(f"startTime not on a half-hour boundary: {start.isoformat()}")


def parse_actual(row: Dict[str, Any]) -> ActualRecord:
    """Validate one FUELHH row. Raises ValueError for malformed rows."""
    if row.get("dataset") not in (None, "FUELHH"):
        raise ValueError(f"unexpected dataset {row.get('dataset')!r}")
    fuel_type = row.get("fuelType")
    if not fuel_type:
        raise ValueError("missing fuelType")
    start = parse_utc(row.get("startTime"))
    _check_interval_alignment(start)
    settlement_date = row.get("settlementDate")
    return ActualRecord(
        start_time=start,
        generation_mw=_parse_generation(row.get("generation")),
        fuel_type=fuel_type,
        settlement_date=date.fromisoformat(settlement_date) if settlement_date else None,
        settlement_period=row.get("settlementPeriod"),
        publish_time=parse_utc(row["publishTime"]) if row.get("publishTime") else None,
        raw=row,
    )


def parse_forecast(row: Dict[str, Any]) -> ForecastRecord:
    """Validate one WINDFOR row. Raises ValueError for malformed rows."""
    if row.get("dataset") not in (None, "WINDFOR"):
        raise ValueError(f"unexpected dataset {row.get('dataset')!r}")
    start = parse_utc(row.get("startTime"))
    _check_interval_alignment(start)
    return ForecastRecord(
        start_time=start,
        publish_time=parse_utc(row.get("publishTime")),
        generation_mw=_parse_generation(row.get("generation")),
        raw=row,
    )


def date_windows(start: date, end: date, days: int) -> Iterator[Tuple[date, date]]:
    """Split the inclusive range [start, end] into inclusive windows of at most `days`."""
    current = start
    while current <= end:
        window_end = min(current + timedelta(days=days - 1), end)
        yield current, window_end
        current = window_end + timedelta(days=1)


def datetime_windows(start: datetime, end: datetime, days: int) -> Iterator[Tuple[datetime, datetime]]:
    """Split the half-open range [start, end) into windows of at most `days`."""
    current = start
    while current < end:
        window_end = min(current + timedelta(days=days), end)
        yield current, window_end
        current = window_end


def _iso_z(value: datetime) -> str:
    return value.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class ElexonClient:
    def __init__(
        self,
        base_url: str,
        timeout_seconds: float = 60.0,
        max_retries: int = 4,
        backoff_seconds: float = 1.0,
        http_client: Optional[httpx.Client] = None,
    ):
        self.base_url = base_url.rstrip("/")
        self.max_retries = max_retries
        self.backoff_seconds = backoff_seconds
        self._http = http_client or httpx.Client(
            timeout=httpx.Timeout(timeout_seconds, connect=10.0),
            headers={"Accept": "application/json", "User-Agent": "reint-wind-forecast-monitor"},
        )

    def close(self) -> None:
        self._http.close()

    def get_json(self, path: str, params: Dict[str, Any]) -> Any:
        url = f"{self.base_url}{path}"
        for attempt in range(self.max_retries + 1):
            try:
                response = self._http.get(url, params=params)
            except httpx.TransportError as exc:
                if attempt >= self.max_retries:
                    raise ElexonError(f"GET {path} failed after {attempt + 1} attempts: {exc}") from exc
                self._sleep(attempt, None, f"network error: {exc}")
                continue
            if response.status_code in RETRYABLE_STATUS and attempt < self.max_retries:
                self._sleep(attempt, response.headers.get("Retry-After"), f"HTTP {response.status_code}")
                continue
            if response.status_code != 200:
                raise ElexonError(f"GET {path} returned HTTP {response.status_code}: {response.text[:300]}")
            try:
                return response.json()
            except ValueError as exc:
                raise ElexonError(f"GET {path} returned invalid JSON") from exc
        raise ElexonError(f"GET {path} exhausted retries")  # pragma: no cover

    def _sleep(self, attempt: int, retry_after: Optional[str], reason: str) -> None:
        delay = self.backoff_seconds * (2 ** attempt)
        if retry_after and retry_after.isdigit():
            delay = max(delay, float(retry_after))
        delay = min(delay, 60.0)
        logger.warning("Elexon request retry %d/%d in %.1fs (%s)", attempt + 1, self.max_retries, delay, reason)
        time.sleep(delay)

    def _expect_list(self, payload: Any, path: str) -> List[Dict[str, Any]]:
        if isinstance(payload, dict) and isinstance(payload.get("data"), list):
            payload = payload["data"]
        if not isinstance(payload, list):
            raise ElexonError(f"GET {path}: expected a JSON array, got {type(payload).__name__}")
        return payload

    def fetch_fuelhh(self, settlement_from: date, settlement_to: date, fuel_type: str = "WIND") -> List[Dict[str, Any]]:
        """FUELHH rows for an inclusive settlement-date range."""
        path = "/datasets/FUELHH/stream"
        params = {
            "settlementDateFrom": settlement_from.isoformat(),
            "settlementDateTo": settlement_to.isoformat(),
            "fuelType": fuel_type,
        }
        return self._expect_list(self.get_json(path, params), path)

    def fetch_windfor(self, publish_from: datetime, publish_to: datetime) -> List[Dict[str, Any]]:
        """WINDFOR rows for forecasts published within the given window."""
        path = "/datasets/WINDFOR/stream"
        params = {"publishDateTimeFrom": _iso_z(publish_from), "publishDateTimeTo": _iso_z(publish_to)}
        return self._expect_list(self.get_json(path, params), path)
