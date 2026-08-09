-- Runs once, on first initialisation of the Postgres volume.
--
-- Nhost's own Postgres image ships with these already present; plain
-- postgres:16 does not, and hasura-auth fails its first migration with
-- 'schema "auth" does not exist' without them. Creating them here keeps the
-- local stack faithful to Nhost Cloud rather than working around the
-- difference later.

CREATE SCHEMA IF NOT EXISTS auth;

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS citext;
