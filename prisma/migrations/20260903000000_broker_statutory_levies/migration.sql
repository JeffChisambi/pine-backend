-- Statutory levies move from compiled-in constants to per-broker configuration.
-- Defaults are the rates that were hard-coded, so existing brokers are unchanged.
ALTER TABLE "broker_fee_configs"
  ADD COLUMN "secLevyPct"        DECIMAL(9,4) NOT NULL DEFAULT 0.1,
  ADD COLUMN "mseLevyPct"        DECIMAL(9,4) NOT NULL DEFAULT 0.1,
  ADD COLUMN "withholdingTaxPct" DECIMAL(9,4) NOT NULL DEFAULT 0;
