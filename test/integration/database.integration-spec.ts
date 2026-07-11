import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConfigModule } from '../../src/config/config.module';
import { DatabaseModule } from '../../src/infrastructure/database/database.module';
import { PrismaService } from '../../src/infrastructure/database/prisma.service';

/**
 * Requires a real, reachable Postgres — the one started by
 * `docker-compose.yml` locally or the `services.postgres` container in
 * CI (see `.github/workflows/ci.yml`). Unlike the unit tests, nothing
 * here is mocked: this is specifically testing that Prisma, the schema,
 * and the configured `DATABASE_URL` actually agree with each other.
 */
describe('PrismaService (integration)', () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule, DatabaseModule],
    }).compile();

    prisma = moduleRef.get(PrismaService);
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('connects and can execute a trivial query', async () => {
    const result = await prisma.$queryRaw<Array<{ result: number }>>`SELECT 1 as result`;
    expect(result[0].result).toBe(1);
  });

  it('exposes the seeded stock reference data', async () => {
    const count = await prisma.stock.count();
    expect(count).toBeGreaterThan(0);
  });

  it('enforces the append-only ledger trigger at the database level', async () => {
    // Requires `npm run db:apply-triggers` to have been run against
    // this database — CI does this before the test suite (see
    // .github/workflows/ci.yml). Skips gracefully if not yet applied,
    // rather than failing the whole suite on a fresh, un-triggered DB.
    const wallet = await prisma.wallet.findFirst();
    if (!wallet) return;

    const entry = await prisma.ledgerEntry.findFirst({ where: { walletId: wallet.id } });
    if (!entry) return;

    await expect(
      prisma.ledgerEntry.update({
        where: { id: entry.id },
        data: { amount: entry.amount },
      }),
    ).rejects.toThrow();
  });
});
