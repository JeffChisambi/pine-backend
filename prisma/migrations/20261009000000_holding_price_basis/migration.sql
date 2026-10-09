-- Separates the price a position was bought at from what it cost.
--
-- Until now a holding carried only averageCost, which includes buying fees.
-- Measuring price gain against it showed every purchase as an immediate loss
-- equal to the fees (about 2.6% on the MSE), indistinguishable from the stock
-- falling. averagePrice holds the fee-free execution average; the realised
-- columns record what sales made, which was not recorded anywhere.
--
-- The new columns start at zero and are filled by replaying each holding's
-- trades: scripts/backfill-holding-basis.ts, run straight after this.
ALTER TABLE "holdings" ADD COLUMN "averagePrice" DECIMAL(18,6) NOT NULL DEFAULT 0;
ALTER TABLE "holdings" ADD COLUMN "realizedPnl" DECIMAL(18,4) NOT NULL DEFAULT 0;
ALTER TABLE "holdings" ADD COLUMN "realizedPricePnl" DECIMAL(18,4) NOT NULL DEFAULT 0;
