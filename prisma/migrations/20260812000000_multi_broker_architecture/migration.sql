-- Multi-broker architecture: broker tenancy, per-broker payment/API
-- configuration, broker admin invitations, and explicit broker
-- ownership on every broker-scoped financial entity.

-- ── Brokers ─────────────────────────────────────────────────────────
CREATE TABLE "brokers" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT,
    "logoUrl" TEXT,
    "contactEmail" TEXT,
    "contactPhone" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "brokers_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "brokers_code_key" ON "brokers"("code");
CREATE INDEX "brokers_isActive_idx" ON "brokers"("isActive");

-- ── Broker payment configuration (secrets encrypted at rest) ────────
CREATE TABLE "broker_payment_configs" (
    "id" UUID NOT NULL,
    "brokerId" UUID NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'MPGS',
    "baseUrl" TEXT,
    "apiVersion" INTEGER NOT NULL DEFAULT 100,
    "environment" TEXT NOT NULL DEFAULT 'test',
    "merchantId" TEXT,
    "apiPasswordEnc" TEXT,
    "apiPasswordIv" TEXT,
    "apiPasswordTag" TEXT,
    "settlementBankName" TEXT,
    "settlementAccountName" TEXT,
    "settlementAccountMasked" TEXT,
    "settlementAccountEnc" TEXT,
    "settlementAccountIv" TEXT,
    "settlementAccountTag" TEXT,
    "isEnabled" BOOLEAN NOT NULL DEFAULT false,
    "updatedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "broker_payment_configs_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "broker_payment_configs_brokerId_key" ON "broker_payment_configs"("brokerId");
ALTER TABLE "broker_payment_configs" ADD CONSTRAINT "broker_payment_configs_brokerId_fkey"
    FOREIGN KEY ("brokerId") REFERENCES "brokers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Broker API configuration ────────────────────────────────────────
CREATE TABLE "broker_api_configs" (
    "id" UUID NOT NULL,
    "brokerId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT,
    "baseUrl" TEXT,
    "secretEnc" TEXT,
    "secretIv" TEXT,
    "secretTag" TEXT,
    "metadata" JSONB,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "updatedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "broker_api_configs_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "broker_api_configs_brokerId_key_key" ON "broker_api_configs"("brokerId", "key");
ALTER TABLE "broker_api_configs" ADD CONSTRAINT "broker_api_configs_brokerId_fkey"
    FOREIGN KEY ("brokerId") REFERENCES "brokers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Broker admin invitations ────────────────────────────────────────
CREATE TABLE "broker_admin_invitations" (
    "id" UUID NOT NULL,
    "brokerId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "broker_admin_invitations_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "broker_admin_invitations_tokenHash_key" ON "broker_admin_invitations"("tokenHash");
CREATE INDEX "broker_admin_invitations_brokerId_idx" ON "broker_admin_invitations"("brokerId");
CREATE INDEX "broker_admin_invitations_userId_idx" ON "broker_admin_invitations"("userId");
ALTER TABLE "broker_admin_invitations" ADD CONSTRAINT "broker_admin_invitations_brokerId_fkey"
    FOREIGN KEY ("brokerId") REFERENCES "brokers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "broker_admin_invitations" ADD CONSTRAINT "broker_admin_invitations_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Broker ownership columns on broker-scoped entities ──────────────
ALTER TABLE "users" ADD COLUMN "brokerId" UUID;
ALTER TABLE "users" ADD COLUMN "brokerSelectedAt" TIMESTAMP(3);
CREATE INDEX "users_brokerId_idx" ON "users"("brokerId");
ALTER TABLE "users" ADD CONSTRAINT "users_brokerId_fkey"
    FOREIGN KEY ("brokerId") REFERENCES "brokers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "wallets" ADD COLUMN "brokerId" UUID;
CREATE INDEX "wallets_brokerId_idx" ON "wallets"("brokerId");
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_brokerId_fkey"
    FOREIGN KEY ("brokerId") REFERENCES "brokers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "transactions" ADD COLUMN "brokerId" UUID;
CREATE INDEX "transactions_brokerId_idx" ON "transactions"("brokerId");
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_brokerId_fkey"
    FOREIGN KEY ("brokerId") REFERENCES "brokers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "orders" ADD COLUMN "brokerId" UUID;
CREATE INDEX "orders_brokerId_idx" ON "orders"("brokerId");
ALTER TABLE "orders" ADD CONSTRAINT "orders_brokerId_fkey"
    FOREIGN KEY ("brokerId") REFERENCES "brokers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "holdings" ADD COLUMN "brokerId" UUID;
CREATE INDEX "holdings_brokerId_idx" ON "holdings"("brokerId");
ALTER TABLE "holdings" ADD CONSTRAINT "holdings_brokerId_fkey"
    FOREIGN KEY ("brokerId") REFERENCES "brokers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "kyc_applications" ADD COLUMN "brokerId" UUID;
CREATE INDEX "kyc_applications_brokerId_idx" ON "kyc_applications"("brokerId");
ALTER TABLE "kyc_applications" ADD CONSTRAINT "kyc_applications_brokerId_fkey"
    FOREIGN KEY ("brokerId") REFERENCES "brokers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "payments" ADD COLUMN "brokerId" UUID;
CREATE INDEX "payments_brokerId_idx" ON "payments"("brokerId");
ALTER TABLE "payments" ADD CONSTRAINT "payments_brokerId_fkey"
    FOREIGN KEY ("brokerId") REFERENCES "brokers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── Backfill ────────────────────────────────────────────────────────
-- Existing single-tenant data predates broker selection; broker
-- ownership stays NULL until an investor selects a broker, at which
-- point application code stamps user + wallet and all subsequently
-- created rows. Rows created after selection are always stamped.
UPDATE "wallets" w SET "brokerId" = u."brokerId"
  FROM "users" u WHERE u."id" = w."userId" AND u."brokerId" IS NOT NULL;
UPDATE "orders" o SET "brokerId" = u."brokerId"
  FROM "users" u WHERE u."id" = o."userId" AND u."brokerId" IS NOT NULL;
UPDATE "holdings" h SET "brokerId" = u."brokerId"
  FROM "users" u WHERE u."id" = h."userId" AND u."brokerId" IS NOT NULL;
UPDATE "kyc_applications" k SET "brokerId" = u."brokerId"
  FROM "users" u WHERE u."id" = k."userId" AND u."brokerId" IS NOT NULL;
UPDATE "payments" p SET "brokerId" = u."brokerId"
  FROM "users" u WHERE u."id" = p."userId" AND u."brokerId" IS NOT NULL;
UPDATE "transactions" t SET "brokerId" = w."brokerId"
  FROM "wallets" w WHERE w."id" = t."walletId" AND w."brokerId" IS NOT NULL;
