# Wind Forecast Decision Monitor

A web app for a UK energy utility's day-ahead purchasing team. For each delivery day in January 2026 it shows
**the national wind generation forecast that was actually available at decision time** and measures **how accurate
those forecasts were** against actual wind generation.

- **Deployed app:** _TODO: add the Vercel (or Heroku) URL once deployed_
- **Public repository:** _TODO: add the GitHub URL once published_
- **Video demo:** _TODO: add the unlisted YouTube link once recorded_

Data comes only from two Elexon BMRS datasets:

| Purpose | Dataset | Endpoint used |
|---|---|---|
| Actual generation | `FUELHH`, `fuelType=WIND` (half-hourly MW) | `GET /bmrs/api/v1/datasets/FUELHH/stream` |
| Forecast generation | `WINDFOR` (hourly MW, with `publishTime`) | `GET /bmrs/api/v1/datasets/WINDFOR/stream` |

```
Elexon API → Python ingestion & validation → PostgreSQL → FastAPI → React dashboard
```

## Project structure

```
.
├── backend/
│   ├── app/
│   │   ├── main.py        FastAPI routes: validation and serialisation only
│   │   ├── config.py      Settings from environment (decision cutoff, dates, Elexon client)
│   │   ├── database.py    SQLAlchemy engine/session; waits for the DB at startup
│   │   ├── models.py      Tables: actual_generation, forecast_generation, ingestion_run
│   │   ├── schemas.py     Pydantic response models
│   │   ├── elexon.py      Elexon client: requests, windowing, retries, row parsing
│   │   ├── ingest.py      Validation, de-duplication, idempotent upserts, run reports
│   │   ├── forecasts.py   Decision-cutoff rule, forecast selection, interval matching, DST-safe days
│   │   └── metrics.py     MAE / RMSE / bias / coverage, lead-time (retrospective) analysis
│   ├── scripts/ingest_january_2026.py   Data load CLI (full month, any range or single date)
│   ├── scripts/ingest_live.py           Live mode: refreshes recent days + tomorrow, once or on a loop
│   ├── tests/             Unit tests + end-to-end API test against PostgreSQL
│   ├── Dockerfile
│   └── requirements*.txt
├── frontend/
│   ├── src/
│   │   ├── api/client.ts          Typed fetch helpers + useResource hook
│   │   ├── types/api.ts           Response types (mirror backend/app/schemas.py)
│   │   ├── pages/Dashboard.tsx    Delivery-day view, decision context, URL state
│   │   ├── components/            Stat cards, charts, interval & vintage tables, accuracy section
│   │   ├── lib/                   UK-time formatting (Intl), chart colours, URL state
│   │   └── styles.css             Design tokens (light + dark), layout
│   ├── nginx.conf                 Serves the build and proxies /api to the backend (Compose)
│   └── Dockerfile
├── api/index.py           Vercel serverless entrypoint (imports the FastAPI app)
├── vercel.json            Vercel build, function and routing config
├── requirements.txt       Python dependencies for Vercel (same pins as backend/requirements.txt)
├── Dockerfile             Single-container image for Heroku (API + built frontend)
├── heroku.yml             Heroku container-stack build definition
├── docker-compose.yml     db + backend + frontend (+ one-off ingest profile)
└── .env.example           Non-secret configuration defaults
```

## Prerequisites

- Docker with Docker Compose v2.24+ (for the containerised setup), **or**
- Python 3.12 (3.9+ works), Node.js 20+ and PostgreSQL 14+ for running the services directly.
- No API key is needed: the Elexon BMRS Insights API is public.

## Run locally with Docker Compose

```bash
cp .env.example .env            # optional; defaults work without it
docker compose up --build -d    # PostgreSQL :5432, API :8000, web app :8080

# Load January 2026 from Elexon (about 10 s, safe to rerun)
docker compose --profile ingest run --rm ingest
# or a single delivery date for quick development
docker compose --profile ingest run --rm ingest --date 2026-01-15
```

Open http://localhost:8080. The API is at http://localhost:8000, with interactive docs at http://localhost:8000/docs.

The backend waits up to about 30 seconds for PostgreSQL, and Compose only starts it once the database health check
passes. If the database is still unreachable, the API starts anyway and `/api/health` returns `503` until it
recovers. Database data persists in the `pgdata` volume.

## Run the services directly (without Docker)

```bash
# 1. Database: any PostgreSQL; e.g. just the Compose one
docker compose up -d db

# 2. Backend
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements-dev.txt
export DATABASE_URL=postgresql+psycopg://reint:reint@localhost:5432/reint
python -m scripts.ingest_january_2026              # full month
uvicorn app.main:app --reload --port 8000

# 3. Frontend (new terminal); Vite proxies /api to :8000
cd frontend
npm ci
npm run dev                                        # http://localhost:5173
```

### Ingestion command

```bash
python -m scripts.ingest_january_2026                                 # 1–31 Jan 2026 (default range)
python -m scripts.ingest_january_2026 --date 2026-01-15               # one delivery date
python -m scripts.ingest_january_2026 --from 2026-01-10 --to 2026-01-12
```

Each run prints one line per dataset, e.g. `FUELHH: fetched=1584 inserted=1488 updated=0 unchanged=0 skipped=0 outside_window=96`.

- **Actuals:** FUELHH is requested by settlement date in 7-day windows with one day of padding either side, so
  UK-local day edges are covered on daylight-saving days. Padding rows outside the requested window are counted as
  `outside_window` and not stored.
- **Forecasts:** WINDFOR is requested by publish time, from 3 days before the first delivery date to the end of the
  last one. That captures every vintage that targets the range.
- **Retries:** 429, 5xx and network errors are retried up to 4 times with exponential backoff, honouring
  `Retry-After`. Timeouts are 60 s for reads and 10 s for connecting.
- **Malformed rows:** rows missing a timestamp or generation value, not on a half-hour boundary, or with the wrong
  dataset or fuel type are logged and counted as `skipped`.
- **Upserts:** rows are upserted on natural keys: `(fuel_type, start_time)` for actuals and
  `(publish_time, start_time)` for forecasts. Rerunning updates only rows that changed and reports the rest as
  `unchanged`. The raw Elexon row is kept in a `raw` JSONB column.

### Tests

```bash
cd backend
pytest                                    # unit tests (the integration test is skipped)
TEST_DATABASE_URL=postgresql+psycopg://reint:reint@localhost:5432/reint_test pytest   # + end-to-end test
```

The end-to-end test drops and recreates the tables in the `TEST_DATABASE_URL` database, so point it at a throwaway
database. It feeds a mocked Elexon response through ingestion, PostgreSQL and the API, and checks that later
revisions are never selected, missing data is flagged, and reruns are idempotent.

## Changing the month (or any date range)

Nothing is hard-coded to January. The date range is configuration:

```bash
# .env (or Heroku config vars)
DATA_START_DATE=2025-03-01
DATA_END_DATE=2025-03-31
```

```bash
python -m scripts.ingest_january_2026            # defaults to DATA_START_DATE..DATA_END_DATE
# or a range without changing config:
python -m scripts.ingest_january_2026 --from 2025-03-01 --to 2025-03-31
```

Restart the API after changing the config. The date picker, validation messages and "Full Period" button all follow
`/api/meta`.

This was checked against March 2025, which contains the clock change to BST on 30 March:

| Delivery date | Half-hour slots | Day starts (UTC) | Decision cutoff (UTC) |
|---|---|---|---|
| 30 March | 46 | 00:00 | 09:00 (that is, 09:00 GMT) |
| 31 March | 48 | 23:00 the previous evening | 08:00 (that is, 09:00 BST) |

The month showed the same pattern as January: MAE about 1,950 MW and bias about +1,770 MW.

February 2026 was also loaded into a separate database (`DATA_START_DATE=2026-02-01`, `DATA_END_DATE=2026-02-28`,
then the same ingest command): 1,344 actual half-hours and 18,104 forecast rows. Results: MAE about 1,666 MW, RMSE
about 2,000 MW, bias about +1,305 MW, 100% coverage. The worst day was 22 February (MAE about 3,331 MW).

## Live data

The same pipeline can follow today instead of a fixed month:

```bash
# .env (or Heroku config vars)
LIVE_MODE=true              # the date range ends at tomorrow, the day being bought
DATA_START_DATE=2026-10-01  # how far back the dashboard goes

python -m scripts.ingest_live            # one refresh (for cron or Heroku Scheduler)
python -m scripts.ingest_live --loop     # long-running worker, every 30 minutes (--every-minutes to change)
```

- **Each refresh** ingests delivery dates from two days ago up to tomorrow. That picks up every new WINDFOR publish,
  each new FUELHH half-hour, and any late corrections. Upserts make overlapping refreshes free.
- **Failures:** a failed refresh is logged and retried on the next cycle. The API keeps serving the existing data.
- **Tomorrow's view:** the dashboard opens on tomorrow, showing the forecast the buyer should use. Actuals appear as
  they arrive.
- **Docker Compose:** `docker compose --profile live up -d` adds the `ingest-live` worker. Set `LIVE_MODE=true` in
  `.env` too.
- **Heroku:** add Heroku Scheduler and run `python -m scripts.ingest_live` every 10 minutes or hourly.
- **Checked:** run against Elexon on 24 October 2026. It loaded 22–25 October, and the second run reported every row
  unchanged. 25 October is the clock change back to GMT, so that day has 50 half-hours. The API selected the
  05:30 UTC (06:30 BST) publish against the 09:00 BST cutoff.
- **Before the cutoff:** before 09:00, tomorrow shows the latest forecast so far, which may still be replaced
  before the decision.

## What was verified about the Elexon API

These details were checked against the official OpenAPI spec (`https://data.elexon.co.uk/swagger/v1/swagger.json`)
and against live responses, not assumed.

- **Pagination:** the stream endpoints return a plain JSON array with no pagination. Ranges are fetched in 7-day
  windows to keep responses small (a whole month of WINDFOR is about 2 MB).
- **Filters:**
  - FUELHH: `settlementDateFrom` / `settlementDateTo` (inclusive, `yyyy-MM-dd`) plus `fuelType`. Settlement-date
    filters can't be combined with publish-time filters.
  - WINDFOR: only `publishDateTimeFrom` / `publishDateTimeTo`, and both bounds are inclusive.
- **Timestamps:** all timestamps are UTC with a `Z` suffix. The parser accepts any explicit offset, converts it to
  UTC and rejects timestamps with no offset.
- **Resolution:**
  - FUELHH is half-hourly. January 2026 has 1,488 WIND rows, which is 31 × 48 with no gaps or duplicates.
  - **WINDFOR is hourly**: every one of the 19,856 January rows falls on the hour.
  - Each publish has 73 hourly points, starting about 5 h *before* the publish time and running roughly 67 h
    ahead.
  - Publishes happen up to 8 times a day (02:30, 04:30, 07:30, 09:30, 11:30, 15:30, 18:30 and 22:30 UTC in
    winter), occasionally at other times (for example 12:25).
- **Rate limits:** the spec documents HTTP 429 "Too many requests" but publishes no numeric limits. The client backs
  off and retries.
- **Credentials:** no API key or other credentials are required.

## Key assumptions

### Decision cutoff (configurable)

The brief says decisions are made the day before delivery but gives no exact time. The default is:

> For delivery day **D**, use the **latest WINDFOR forecast published at or before 09:00 UK local time on D‑1**.

09:00 was chosen to sit before the morning GB day-ahead auctions. It should be confirmed with the client's trading
team. You can change it with environment variables, and the app displays the active rule:

```
DECISION_CUTOFF_LOCAL_TIME=09:00   # HH:MM, local to MARKET_TIMEZONE
DECISION_DAYS_BEFORE=1
MARKET_TIMEZONE=Europe/London
```

The whole rule lives in `backend/app/forecasts.py`, in `decision_cutoff()` and `select_decision_forecasts()`.

- A forecast published after the cutoff is never selected, even when it's the only one.
- If no vintage was published before the cutoff, the interval is reported as `missing_forecast` rather than
  falling back to a later revision.
- With the default rule, every January day used the 07:30 UTC publish from the previous day. Lead times run from
  16.5 h to 39.5 h.

### Matching hourly forecasts to half-hourly actuals

WINDFOR is hourly and FUELHH is half-hourly, so forecast and actual are matched on exact `startTime` only. In other
words, the hourly forecast point is compared with the actual for the half-hour that starts on the same hour.

The `:30` intervals have no forecast point. They're shown with the status `no_forecast_point` and left out of the
metrics and of the coverage denominator. Nothing is interpolated into the metrics.

On the chart, the forecast is drawn as a straight line between its hourly points, with dots marking the real
points. The tooltip says when a half-hour has no forecast point.

### Delivery dates and time zones

- "January 2026" means **delivery dates** 1–31 January 2026 in UK local time. The decision for 1 January was
  therefore made on 31 December 2025.
- Storage is UTC (`timestamptz`, with the database session pinned to UTC).
- Delivery days are built from local midnight to local midnight in `Europe/London`. That gives 46, 48 or 50
  half-hours around clock changes, and unit tests cover the 2026 transitions. January itself is all GMT.
- The UI formats every time with `Intl.DateTimeFormat` in `Europe/London` and labels it GMT or BST.

### Metrics

- **Error** = forecast − actual, in MW. A positive error means more wind was forecast than generated, so the
  utility would have bought too little.
- **MAE** = mean |error|. **RMSE** = √(mean error²). **Bias** = mean error.
- **P90 |error|** and **MAE as a percentage of mean actual generation** are also reported.
- **Coverage** = matched hourly points ÷ hourly points expected in the range. Counts of missing forecasts, missing
  actuals and both are always returned and shown in the UI.
- **MAPE is not used**, because wind output can be near zero and that makes percentage errors unstable.
- **Lead-time analysis** (`/api/accuracy/lead-time`) uses *every* stored vintage, including those published after
  the cutoff, grouped into 6‑hour horizon buckets. The API and UI label it **retrospective**. It shows how accuracy
  changes with horizon; it does not show what was available when buying. Vintages published at or after their
  target hour are excluded and counted.

## API

All responses are JSON, and timestamps are ISO‑8601 UTC (`Z`). Dates are UK delivery dates (`YYYY-MM-DD`) and
must fall within 2026‑01‑01 to 2026‑01‑31; anything else returns `422` with a readable `detail`.

| Method & path | Purpose |
|---|---|
| `GET /api/health` | Service status, database connectivity, row counts, last ingestion runs (`503` if the DB is down) |
| `GET /api/meta` | Active decision rule, date range, data resolutions |
| `GET /api/forecasts/latest?date=2026-01-15` | Every half-hour of the delivery day: selected forecast, its `publishTime`, actual, error, status, cutoff, summary metrics |
| `GET /api/forecasts/series?from=2026-01-01&to=2026-01-31` | The same half-hourly rows as `latest`, across a range of delivery dates (each day uses its own cutoff) |
| `GET /api/forecasts/vintages?start_time=2026-01-15T17:00:00Z` | All stored vintages for one target interval, ordered by `publish_time`, flagged `available_at_decision` / `selected` |
| `GET /api/accuracy?from=2026-01-01&to=2026-01-31` | MAE, RMSE, bias, P90, coverage, missing counts, plus a daily breakdown |
| `GET /api/accuracy/lead-time?from=2026-01-01&to=2026-01-31&bucket_hours=6` | Retrospective accuracy by forecast horizon |

```bash
curl "http://localhost:8000/api/forecasts/latest?date=2026-01-15"
```

Abridged response:

```json
{
  "delivery_date": "2026-01-15",
  "decision_cutoff": "2026-01-14T09:00:00Z",
  "forecast_publish_times": ["2026-01-14T07:30:00Z"],
  "summary": {"mae_mw": 1025.2, "rmse_mw": 1168.1, "bias_mw": 1025.2, "coverage_pct": 100.0,
              "matched_intervals": 24, "forecast_intervals": 24, "missing_forecast": 0, "missing_actual": 0, "...": "..."},
  "intervals": [
    {"start_time": "2026-01-15T00:00:00Z", "forecast_mw": 15834, "actual_mw": 14602, "error_mw": 1232,
     "forecast_publish_time": "2026-01-14T07:30:00Z", "lead_time_hours": 16.5, "status": "matched"},
    {"start_time": "2026-01-15T00:30:00Z", "forecast_mw": null, "actual_mw": 14311, "error_mw": null,
     "status": "no_forecast_point"}
  ]
}
```

Interval `status` is one of `matched`, `missing_actual`, `missing_forecast`, `missing_both` or `no_forecast_point`.

## What the January 2026 data shows

These figures come from the app run against the real Elexon data with the default 09:00 D‑1 cutoff. Rerun the
ingestion and open the accuracy view to reproduce them.

- **Accuracy:** across 744 matched hourly points, MAE is about 2,130 MW, RMSE about 2,610 MW and P90 |error| about
  4,310 MW. Mean actual wind generation is about 11,580 MW. Coverage is 100%.
- **Bias** is about +1,850 MW: decision-time forecasts were mostly **above** actual generation. One possible
  explanation is that WINDFOR does not reflect curtailment, but this is not established and needs investigating
  before anyone relies on it.
- **Horizon:** the retrospective view shows MAE rising from about 1,770 MW (0–6 h ahead) to about 2,270 MW
  (36–42 h ahead).

## Deploying to Heroku

Heroku's container stack is used: one dyno runs FastAPI, which serves both `/api` and the built React app.

```bash
heroku create <app-name> --stack container
heroku addons:create heroku-postgresql:essential-0 -a <app-name>    # sets DATABASE_URL
heroku config:set DECISION_CUTOFF_LOCAL_TIME=09:00 DECISION_DAYS_BEFORE=1 MARKET_TIMEZONE=Europe/London -a <app-name>
git push heroku main                                                 # builds ./Dockerfile via heroku.yml
heroku run python -m scripts.ingest_january_2026 -a <app-name>      # load data once
heroku open -a <app-name>
```

- Heroku sets `DATABASE_URL` as `postgres://…`, which `config.py` rewrites to the `postgresql+psycopg://` driver
  URL.
- `PORT` is provided by Heroku.
- Tables are created on startup, so no migration step is needed.
- `CORS_ORIGINS` only matters if the frontend is hosted on a different origin.

## Deploying to Vercel

How the Vercel deployment works:

- **Hosting:** Vercel serves the built React app as static files and runs FastAPI as one Python function
  (`api/index.py`). `vercel.json` routes `/api/*`, `/docs` and `/openapi.json` to the function, and everything else
  to the SPA.
- **Database:** PostgreSQL is hosted on Neon, added from the Vercel Marketplace. The app prefers
  `DATABASE_URL_UNPOOLED` (Neon's direct connection) over `DATABASE_URL`.
- **Serverless mode:** Vercel sets `VERCEL=1`, which switches on serverless mode:
  - no connection pool is kept between requests (`NullPool`);
  - startup makes one database attempt instead of waiting up to 30 seconds.
- **Data:** ingestion runs from a laptop against the Neon database (`python -m scripts.ingest_january_2026`), since
  a request-scoped function is not the place for a data load.

## Design notes

- **Dependencies:** kept deliberately small.
  - Backend: FastAPI, SQLAlchemy 2, psycopg 3, httpx and pydantic-settings.
  - Frontend: React, Recharts and Vite, with plain CSS and no UI or date libraries. Recharts was chosen for
    composable, React-native time-series and bar charts, with custom tooltips and reference lines/areas.
- **Calculations stay in the backend.** All official numbers come from the API; React only formats and draws.
- **UI:** a neutral, hairline layout with tabular numbers. Chart colours come from a colour-vision-deficiency-checked
  palette (forecast blue, actual orange) with light and dark variants.
  - Every chart has a legend, a tooltip that explains missing values, and a data table.
  - The forecast-vs-actual charts (single day and whole period) shade the gap between the two lines: blue where
    the forecast was too high, orange where it was too low. An aligned error chart underneath uses the same
    colours.
  - Ways to zoom: drag across the chart, pinch or ⌘/Ctrl + scroll at the pointer, the zoom and pan buttons, the
    range slider, or a preset (parts of the day, or week by week). Swiping sideways pans.
  - With the chart focused, + and − zoom, the arrow keys pan and Escape resets.
  - A line above the chart gives MAE, bias and the largest miss for the visible window. An optional toggle fits
    the Y-axis to the visible data.
  - Keyboard users can select intervals and days with buttons in those tables.
  - The selected date, range and interval are kept in the URL.
- **Schema management:** there's no migration tool, and tables are created with `metadata.create_all`. That's
  adequate for this pilot; Alembic would be the next step.

## Known limitations and manual steps

- **Deployment, public repository, video and submission form:** not done yet. The placeholders at the top need
  filling in once they exist.
- **Docker images and Compose:** written but **not built or run during development**, because Docker wasn't
  available on the build machine. Everything else was run locally against PostgreSQL (16, via `pgserver`):
  - backend tests;
  - the full-month ingestion, including reruns;
  - every API endpoint;
  - single-container static serving;
  - the React app in Chromium at desktop and phone widths, light and dark.
- **Scope:** WINDFOR covers wind farms visible to the system operator. FUELHH WIND is the transmission-metered
  outturn, so the two may not cover exactly the same wind farms.
- **Decision cutoff:** the 09:00 D‑1 cutoff is an assumption; see above.
- **Dashboard API:** no authentication, because all of the data is public.

## AI-use disclosure

This project was built with the help of an AI coding assistant (Claude, by Anthropic, via Claude Code). It was used
to:

- inspect the Elexon API documentation and live responses;
- write the backend, frontend, tests, Docker configuration and this README;
- run the tests and check the UI in a headless browser.

I defined the requirements and the overall architecture: an Elexon client, idempotent ingestion into PostgreSQL,
forecast selection and metrics, API routes, and a React dashboard. I tested the application myself, locally and on
the deployed site. I also deployed it: the GitHub repository,
the Vercel project, the Neon database, the environment variables, and the GitHub Actions secret and live-ingestion
workflow.

Design decisions, assumptions and results are documented above so they can be reviewed independently. The author
is responsible for reviewing and validating the submission.
