#!/bin/sh
# Postgres first-boot init (runs once via docker-entrypoint-initdb.d).
# Creates the schema + a LEAST-PRIVILEGE app role whose password comes from the
# ENVIRONMENT (APP_DB_PASSWORD) — so NO secret is committed to the repo (§S2).
# In compose the env is set from .env (gitignored); in k8s from a Secret.
set -e

: "${APP_DB_USER:=iocheck_app}"
: "${APP_DB_PASSWORD:?APP_DB_PASSWORD must be set for the iocheck app role}"

psql -v ON_ERROR_STOP=1 \
     --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
     -v app_user="$APP_DB_USER" \
     -v app_password="$APP_DB_PASSWORD" \
     -v dbname="$POSTGRES_DB" <<'EOSQL'
-- ---- schema -------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ioc (
  type      text        NOT NULL,        -- 'ip' | 'domain' | 'sha256'
  value     text        NOT NULL,        -- normalized/canonicalized before insert (§S3)
  source    text        NOT NULL,
  score     int         NOT NULL CHECK (score BETWEEN 0 AND 100),
  added_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (type, value)
);

-- ---- least-privilege app role (password injected from env, never committed) ----
-- format(%I, %L) safely quotes the identifier and the password literal.
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', :'app_user', :'app_password')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'app_user')
\gexec

GRANT CONNECT ON DATABASE :"dbname" TO :"app_user";
GRANT USAGE  ON SCHEMA public       TO :"app_user";
GRANT SELECT, INSERT, UPDATE ON TABLE ioc TO :"app_user";
-- Deliberately NO DELETE, NO DDL, NO access to other tables.

-- ---- seed data so /lookup returns something in dev ----------------------------
INSERT INTO ioc (type, value, source, score) VALUES
  ('ip',     '203.0.113.7',                                                      'seed-abuseipdb', 90),
  ('domain', 'malware-example.test',                                             'seed-internal',  75),
  ('sha256', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'seed-internal',  60)
ON CONFLICT (type, value) DO NOTHING;
EOSQL
