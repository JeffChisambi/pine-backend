-- Pine platform commission: per-trade platform fee + singleton platform config

ALTER TABLE "trades" ADD COLUMN "platformFee" DECIMAL(18,4) NOT NULL DEFAULT 0;

CREATE TABLE "platform_config" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "platformCommissionPct" DECIMAL(7,4) NOT NULL DEFAULT 0,
    "updatedById" UUID,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_config_pkey" PRIMARY KEY ("id")
);

INSERT INTO "platform_config" ("id", "platformCommissionPct", "updatedAt") VALUES ('default', 0, CURRENT_TIMESTAMP);
