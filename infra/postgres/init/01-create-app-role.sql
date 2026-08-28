-- Runs once, on first container start, as the superuser.
--
-- Creates the login role the application uses. It is deliberately NOT the database owner and
-- NOT a superuser, because Row-Level Security does not apply to either — see
-- packages/db/migrations/0002_roles_and_rls.sql for the full reasoning and the assertions
-- that enforce it.
--
-- Migrations connect as `shikkha_migrator` (the POSTGRES_USER, which owns the database);
-- the API connects as `shikkha_app`.

create role shikkha_app with login password 'shikkha_dev_password' nobypassrls;
create role shikkha_readonly with login password 'shikkha_dev_password' nobypassrls;

grant connect on database shikkha_dev to shikkha_app, shikkha_readonly;

-- A separate database for the integration and tenant-isolation suites, so a test run that
-- truncates tables cannot destroy a developer's seeded demo tenant.
create database shikkha_test owner shikkha_migrator;
grant connect on database shikkha_test to shikkha_app, shikkha_readonly;
