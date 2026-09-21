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

## Status
Phase 1 done: auth, RBAC, company master + settings (shift OFF by default), dashboard, audit log, tenant isolation tests.
Phases 1-8 done. Apply migrations with `npm run db:migrate` (0004 adds the temporary-password flag). Phases 9-10 next.

## Deploy on Render
1. Push this repo to GitHub, then in Render choose **New > Blueprint** and select the repo (it reads `render.yaml`).
2. When asked, fill the secrets: `ENCRYPTION_KEY` (run `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`), `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD` (10+ characters).
3. Render builds the Docker image, applies migrations, creates your admin on first start and serves the app at your `onrender.com` URL. Sign in with the email and password you set.
4. After the first successful start you can set `RUN_SEED` to `false`.

Keep `ENCRYPTION_KEY` safe and never change it: bank, PAN and Aadhaar values are encrypted with it and cannot be recovered without it. The free plans sleep when idle and the free database expires; use paid plans for real payroll data. Compliance rules (PT, LWF, TDS) start empty: add them under "Compliance rules".
