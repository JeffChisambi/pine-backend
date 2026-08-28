-- Broker-configurable risk & compliance constraints (concentration + deposit limits)

CREATE TABLE "broker_risk_configs" (
    "id" UUID NOT NULL,
    "brokerId" UUID NOT NULL,
    "concentrationEnabled" BOOLEAN NOT NULL DEFAULT false,
    "maxPositionPct" DECIMAL(5,2) NOT NULL DEFAULT 100,
    "warnPositionPct" DECIMAL(5,2),
    "depositRules" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "broker_risk_configs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "broker_risk_configs_brokerId_key" ON "broker_risk_configs"("brokerId");
ALTER TABLE "broker_risk_configs" ADD CONSTRAINT "broker_risk_configs_brokerId_fkey"
    FOREIGN KEY ("brokerId") REFERENCES "brokers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
