#!/bin/sh
# Database-per-service inside one cluster: each service gets its own role and schema
# and cannot read another service's tables. Runs once, on an empty data volume.
set -eu

for svc in accounts dispatch intercity; do
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<SQL
CREATE ROLE ${svc} LOGIN PASSWORD '${SERVICE_DB_PASSWORD}';
CREATE SCHEMA ${svc} AUTHORIZATION ${svc};
REVOKE ALL ON SCHEMA ${svc} FROM PUBLIC;
ALTER ROLE ${svc} SET search_path TO ${svc};
SQL
done
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -c "REVOKE CREATE ON SCHEMA public FROM PUBLIC;"
