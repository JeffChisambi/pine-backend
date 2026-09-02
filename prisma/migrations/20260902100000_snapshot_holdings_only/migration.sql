-- Portfolio history must track STOCK holdings only: including wallet cash made
-- a deposit look like portfolio growth and counted cash as lifetime profit.

ALTER TABLE "portfolio_snapshots" ADD COLUMN "holdingsValue" DECIMAL(18,4) NOT NULL DEFAULT 0;
ALTER TABLE "portfolio_snapshots" ADD COLUMN "cashBalance" DECIMAL(18,4) NOT NULL DEFAULT 0;

-- Exact reconstruction of history: unrealizedPnl = marketValue - costBasis,
-- therefore holdings market value = totalCost + unrealizedPnl. No estimation.
UPDATE "portfolio_snapshots"
SET "holdingsValue" = "totalCost" + "unrealizedPnl",
    "cashBalance"   = "totalValue" - ("totalCost" + "unrealizedPnl");
