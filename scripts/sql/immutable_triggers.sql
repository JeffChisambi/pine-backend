-- Pine Backend — immutability triggers
--
-- Prisma migrations define table shape but not this kind of
-- application-independent constraint, so it's applied as a follow-up
-- raw-SQL step (see package.json "db:apply-triggers" and the README).
-- Run once after every `prisma migrate deploy` against a fresh
-- database; migrations that don't touch these two tables don't need to
-- re-run it, but re-running is always safe (idempotent, `CREATE OR
-- REPLACE` / `DROP TRIGGER IF EXISTS`).
--
-- Belt-and-braces: application code never calls `.update()`/`.delete()`
-- on `ledger_entries` or `audit_logs` (enforced by code review and the
-- repository interfaces in `shared/base`), but a compromised DB
-- credential or a future bug should not be able to rewrite financial
-- or audit history either. These triggers make that impossible at the
-- database layer, independent of the application.

CREATE OR REPLACE FUNCTION prevent_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Table "%" is append-only: % is not permitted (row id: %)',
    TG_TABLE_NAME, TG_OP, OLD.id;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ledger_entries_no_update ON ledger_entries;
CREATE TRIGGER ledger_entries_no_update
  BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION prevent_mutation();

DROP TRIGGER IF EXISTS audit_logs_no_update ON audit_logs;
CREATE TRIGGER audit_logs_no_update
  BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION prevent_mutation();
