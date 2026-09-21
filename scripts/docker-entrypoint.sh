#!/bin/sh
set -e
cd /app/apps/api
# Apply pending migrations, optionally create the first admin, then start.
npx prisma migrate deploy
if [ "$RUN_SEED" = "true" ]; then npx tsx prisma/seed.ts; fi
exec node dist/main.js
