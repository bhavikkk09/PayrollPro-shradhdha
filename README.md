# LabourConsultPro

Multi-company payroll and compliance system for labour law consultants. NestJS + Prisma + PostgreSQL API, React + Tailwind UI.
See `docs/ARCHITECTURE.md` (design, isolation model, ERD).

## Run (needs Docker or a local PostgreSQL)
```
cp apps/api/.env.example apps/api/.env      # set DATABASE_URL and JWT_SECRET (32+ chars)
npm install
npm run db:migrate && npm run db:seed        # demo login: admin@demo-consultant.in / Admin@12345 (change it)
npm run api                                  # http://localhost:3000/api/docs (Swagger)
npm run web                                  # http://localhost:5173
```
Docker: `JWT_SECRET=... docker compose up --build` (adds Postgres, Redis, daily backup job).

## Backup & restore
`docker compose up` runs a `backup` container that takes an immediate `pg_dump | gzip` on start, then every 24h, into `./backups/`, verifies each file with `gzip -t`, and deletes anything older than `RETENTION_DAYS` (default 14). Ship `./backups` off the host in production (object storage, another disk) — a backup that lives next to the database it protects does not survive a disk failure.

**Restore** (stop the API first so nothing writes during the restore):
```
docker compose stop api
gunzip -c backups/lcp_YYYYMMDD_HHMMSS.sql.gz | docker compose exec -T db psql -U lcp lcp
docker compose start api
```
This replays SQL statements into the existing `lcp` database, so restoring into anything but an empty/matching schema can conflict; to restore into a clean database instead, drop and recreate it first (`docker compose exec db dropdb -U lcp lcp && docker compose exec db createdb -U lcp lcp`), then run the `gunzip | psql` line above.

**Render's free Postgres has no built-in backups and expires after 90 days** — the Blueprint here does not run the `backup` container (Render's Docker web service only runs the API image). For real payroll data, either upgrade the Render database to a paid plan (which includes automated daily backups and point-in-time recovery), or schedule your own: copy the **External Database URL** from the Render Postgres dashboard and run `pg_dump "$EXTERNAL_URL" | gzip > lcp_$(date +%Y%m%d).sql.gz` from any machine with the Postgres client tools, on a cron job.

## Status
Phases 1-10 done: auth/RBAC/company, employees, salary, attendance/leave/shift, payroll engine, compliance, reports/payslips, client portal, documents/notifications/audit log, backup/Docker/deployment hardening. Apply migrations with `npm run db:migrate` (0005 adds documents, notifications and the append-only audit trigger; 0006 adds an index behind monthly leave accrual). See `docs/ARCHITECTURE.md` for what Phase 10 changed.

## Deploy on Render
1. Push this repo to GitHub, then in Render choose **New > Blueprint** and select the repo (it reads `render.yaml`).
2. When asked, fill the secrets: `ENCRYPTION_KEY` (run `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`), `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD` (10+ characters).
3. Render builds the Docker image, applies migrations, creates your admin on first start and serves the app at your `onrender.com` URL. Sign in with the email and password you set.
4. After the first successful start you can set `RUN_SEED` to `false`.

Keep `ENCRYPTION_KEY` safe and never change it: bank, PAN and Aadhaar values are encrypted with it and cannot be recovered without it. The free plans sleep when idle and the free database expires; use paid plans for real payroll data. Compliance rules (PT, LWF, TDS) start empty: add them under "Compliance rules".
