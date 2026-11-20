#!/bin/sh
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set=app_password="$(cat /run/secrets/postgres_app_password)" <<'SQL'
SELECT 'CREATE ROLE mpu_runtime LOGIN' WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname='mpu_runtime') \gexec
ALTER ROLE mpu_runtime PASSWORD :'app_password';
CREATE SCHEMA IF NOT EXISTS desk AUTHORIZATION mpu_runtime;
CREATE SCHEMA IF NOT EXISTS indodax_stops AUTHORIZATION mpu_runtime;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
SQL
