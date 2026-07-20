-- AlterTable: add optional turnover column to stock_prices
-- Stores MSE-reported daily turnover in MWK (24,4 precision)
ALTER TABLE "stock_prices" ADD COLUMN IF NOT EXISTS "turnover" DECIMAL(24,4);
