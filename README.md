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
Phase 2 done: org masters + employee master (sensitive fields encrypted). Re-run `npm run db:seed` after pulling to add the new employee.sensitive permission. Phases 3-10 next.
