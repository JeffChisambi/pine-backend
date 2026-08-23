-- Broker fee configuration + commission/levy breakdown on trades

CREATE TYPE "FeeKind" AS ENUM ('FIXED', 'PERCENT');

CREATE TABLE "broker_fee_configs" (
    "id" UUID NOT NULL,
    "brokerId" UUID NOT NULL,
    "depositFeeEnabled" BOOLEAN NOT NULL DEFAULT false,
    "depositFeeKind" "FeeKind" NOT NULL DEFAULT 'PERCENT',
    "depositFeeValue" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "depositFeeDescription" TEXT,
    "commissionEnabled" BOOLEAN NOT NULL DEFAULT true,
    "commissionTiers" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "broker_fee_configs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "broker_fee_configs_brokerId_key" ON "broker_fee_configs"("brokerId");
ALTER TABLE "broker_fee_configs" ADD CONSTRAINT "broker_fee_configs_brokerId_fkey"
    FOREIGN KEY ("brokerId") REFERENCES "brokers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "trades" ADD COLUMN "commission" DECIMAL(18,4) NOT NULL DEFAULT 0;
ALTER TABLE "trades" ADD COLUMN "levies" DECIMAL(18,4) NOT NULL DEFAULT 0;

-- Backfill existing trades: levies were 0.2% of gross (SEC 0.1% + MSE 0.1%);
-- commission is the remainder of the recorded total fee.
UPDATE "trades"
SET "levies" = ROUND(("quantity" * "price") * 0.002, 4),
    "commission" = GREATEST("fee" - ROUND(("quantity" * "price") * 0.002, 4), 0)
WHERE "fee" > 0;
