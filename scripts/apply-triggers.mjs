// Applies scripts/sql/immutable_triggers.sql against DATABASE_URL.
// Plain Node + `pg`, deliberately outside Prisma's migration system —
// see the comment at the top of the SQL file for why.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL is not set');
    process.exit(1);
  }

  const sql = readFileSync(path.join(__dirname, 'sql', 'immutable_triggers.sql'), 'utf-8');
  const client = new pg.Client({ connectionString: databaseUrl });

  await client.connect();
  try {
    await client.query(sql);
    console.log('✅ Immutability triggers applied to ledger_entries and audit_logs');
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error('❌ Failed to apply immutability triggers:', error);
  process.exit(1);
});
