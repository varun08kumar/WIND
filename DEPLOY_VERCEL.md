# Deploying to Vercel

A step-by-step guide to putting the Wind Forecast Decision Monitor online with **Vercel** (website + API) and
**Neon** (PostgreSQL). Both have free plans, and no payment card is needed.

## How it runs on Vercel

```
Browser
  │
  ├── /            → Vercel static hosting   → React app (frontend/dist)
  └── /api/...     → Vercel Python function  → FastAPI (api/index.py → backend/app)
                                                   │
                                                   └── Neon PostgreSQL

Your laptop ── python -m scripts.ingest_january_2026 ──► Neon PostgreSQL   (one-off data load)
```

| File | What it does |
|---|---|
| `vercel.json` | Builds the frontend; sends `/api/*`, `/docs` and `/openapi.json` to FastAPI and everything else to the React app |
| `api/index.py` | The Vercel function. It imports the existing FastAPI app from `backend/app` |
| `requirements.txt` | Tells Vercel which Python packages to install. It is a copy of `backend/requirements.txt`, because Vercel can't follow `-r` includes, so keep the two in sync |
| `.vercelignore` | Keeps local files (`.env`, `node_modules`, caches) out of the upload |

The backend code is the same one used by Docker and Heroku. Vercel sets `VERCEL=1` automatically, and the app
then switches to serverless mode:
- it opens a database connection per request instead of keeping a pool;
- it doesn't wait 30 seconds for the database at startup.

---

## Before you start

You need:
- a **GitHub** account;
- a **Vercel** account: sign up at https://vercel.com with GitHub (the free "Hobby" plan is fine);
- on your laptop: **git**, **Node 18+** and **Python 3.11+**.

---

## Step 1: Put the code on GitHub

The challenge asks for a public repo with an **anonymous name** (a random string, e.g. `kjhwr`).

1. On https://github.com/new, create a **public**, **empty** repo named something like `kjhwr`. Don't add a README,
   because the project already has one.
2. In a terminal:

```bash
cd /Users/varun/Documents/Reint
git init
git add .
git commit -m "Wind forecast decision monitor"
git branch -M main
git remote add origin https://github.com/<your-user>/kjhwr.git
git push -u origin main
```

`.gitignore` already excludes `.env`, `node_modules` and build output, so no secrets are pushed.

Check on GitHub that you can see `vercel.json`, `api/index.py`, `backend/` and `frontend/`.

---

## Step 2: Create the Vercel project

1. Go to https://vercel.com/new and **Import** the GitHub repo.
2. On the configuration screen:
   - **Framework Preset:** `Other`
   - **Root Directory:** leave it as `./` (the repository root, where `vercel.json` is)
   - **Build and Output Settings:** leave them alone, because `vercel.json` sets them
3. Click **Deploy**.

The first deploy builds the site, but the API can't reach a database yet. That's expected; step 3 adds one.

---

## Step 3: Add a PostgreSQL database (Neon)

1. In your Vercel project, open the **Storage** tab, click **Create Database**, choose **Neon** (Serverless Postgres)
   and click **Continue**.
2. Pick a region close to the UK (e.g. **London** or **Frankfurt**) and the **Free** plan, then create it.
3. When asked, **connect it to this project** for all environments (Production, Preview, Development).

Vercel now adds environment variables to the project automatically, including:

| Variable | Used by the app? |
|---|---|
| `DATABASE_URL_UNPOOLED` | **Yes.** Neon's direct connection, which the app prefers |
| `DATABASE_URL` | Fallback, used only if the unpooled one is missing |

**If you created the database on neon.tech yourself** instead: in Vercel → Settings → Environment Variables, add
`DATABASE_URL_UNPOOLED`. Set it to Neon's **direct** connection string (Neon dashboard → Connect → turn
"Connection pooling" **off**). It looks like
`postgresql://user:password@ep-xxxx.eu-west-2.aws.neon.tech/neondb?sslmode=require`.

---

## Step 4: (Optional) Set the business settings

The defaults already match the challenge, so you can skip this step. To set them explicitly, add them in
Vercel → **Settings → Environment Variables**:

| Variable | Default | Meaning |
|---|---|---|
| `DECISION_CUTOFF_LOCAL_TIME` | `09:00` | Time of the buying decision, UK local |
| `DECISION_DAYS_BEFORE` | `1` | Days before delivery |
| `MARKET_TIMEZONE` | `Europe/London` | Time zone of the rule |
| `DATA_START_DATE` | `2026-01-01` | First delivery date shown |
| `DATA_END_DATE` | `2026-01-31` | Last delivery date shown |

---

## Step 5: Redeploy

Environment variables only apply to new deployments:

**Deployments** tab → the latest deployment → **⋯** → **Redeploy**.

---

## Step 6: Load the January data into Neon (from your laptop)

The data load takes about 10 seconds and is safe to repeat. Run it from your laptop against the Neon database.

1. Copy the database URL: Vercel → **Settings → Environment Variables** → `DATABASE_URL_UNPOOLED` → reveal and copy.
   You can also copy it from the Neon dashboard (with pooling off).
2. Run:

```bash
cd /Users/varun/Documents/Reint/backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

DATABASE_URL="<paste the URL here>" python -m scripts.ingest_january_2026
```

It should end with:

```
FUELHH: fetched=1584 inserted=1488 updated=0 unchanged=0 skipped=0 outside_window=96
WINDFOR: fetched=19856 inserted=19856 updated=0 unchanged=0 skipped=0 outside_window=0
```

The tables are created automatically on the first run. **Never commit this URL**: it contains the database password.

---

## Step 7: Check that it works

Replace `<app>` with your Vercel URL (shown on the project page, e.g. `kjhwr.vercel.app`):

| Open | You should see |
|---|---|
| `https://<app>/api/health` | `"status":"ok","database":"ok","actual_rows":1488,"forecast_rows":19856` |
| `https://<app>/` | The dashboard, opening on 31 January 2026 |
| `https://<app>/?date=2026-01-15` | 15 January: MAE 1,025 MW, forecast used published Wed 14 Jan 07:30 GMT |
| `https://<app>/docs` | The interactive API documentation |

Then open the site in an **incognito window**, as the challenge asks, to make sure it works without being logged
in.

The first request after a quiet period can take 1–3 seconds. Both the Vercel function and the Neon database
"wake up" from idle; after that it's fast.

---

## Step 8: Fill in the README

Replace the placeholders at the top of `README.md` with the real links, then push again:

```bash
git add README.md
git commit -m "Add deployed URL"
git push
```

Vercel redeploys automatically on every push to `main`.

---

## Troubleshooting

| Problem | Likely cause | Fix |
|---|---|---|
| `/api/health` shows `"database":"error"` | Database URL missing, wrong, or added after the last deploy | Check `DATABASE_URL_UNPOOLED` in Settings → Environment Variables, then **Redeploy** |
| `/api/...` returns 404 | `vercel.json` not at the repo root, or Root Directory changed | Root Directory must be `./`; `vercel.json` must be in the repo root |
| Function error `ModuleNotFoundError: No module named 'app'` | Backend files not bundled | Check `vercel.json` has `"includeFiles": "backend/app/**"`, and that `backend/app` is in the repo |
| Build error `PYTHON_REQUIREMENTS_PARSE_ERROR` | The root `requirements.txt` uses `-r` | Copy the lines of `backend/requirements.txt` into the root `requirements.txt`, then push |
| Dashboard shows "No data stored for …" | Step 6 not done, or done against another database | Run the ingest command with the same URL Vercel uses |
| Error mentioning `options` or `startup parameter` | Using Neon's **pooled** URL | Use the **unpooled/direct** URL as `DATABASE_URL_UNPOOLED` |
| Build fails in `npm ci` | `frontend/package-lock.json` missing from the repo | Commit `frontend/package-lock.json` |

**Logs:** Vercel → your project → **Logs** (function errors appear there), or **Deployments** → a deployment →
**Build Logs**.

---

## Optional: deploy from the terminal instead of the website

```bash
npm i -g vercel
cd /Users/varun/Documents/Reint
vercel login
vercel link          # create or link the project
vercel               # preview deployment
vercel --prod        # production deployment
vercel env pull .env # copy the environment variables locally (never commit .env)
```

---

## Optional: keep the data live

`scripts/ingest_live.py` refreshes recent days and tomorrow. On Vercel it isn't run by the app; run it on a
schedule from somewhere else:
- a computer or server: `DATABASE_URL="<url>" python -m scripts.ingest_live --loop`;
- a scheduled GitHub Actions workflow running `python -m scripts.ingest_live` every 30 minutes, with the URL stored
  as a repository secret.

Also set `LIVE_MODE=true` in Vercel so the date range follows today.

---

## How to explain this setup in the interview

> "On Vercel, the React build is served as static files from Vercel's CDN. FastAPI runs as a single Python
> serverless function, and vercel.json routes /api to it. PostgreSQL is on Neon. Serverless functions start and
> stop per request, so the app detects Vercel: it opens a connection per request instead of keeping a pool, and
> uses Neon's direct connection URL. Ingestion is a batch job, so it runs outside the request path, from a laptop
> or a scheduler, against the same database. The same code also runs in Docker Compose and on Heroku, so only the
> hosting changed, not the application."
