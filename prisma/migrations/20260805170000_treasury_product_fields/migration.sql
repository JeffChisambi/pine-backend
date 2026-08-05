-- Extend treasury products with the display fields the mobile T-bill screens
-- need (risk level, auction/issue/maturity dates, status), so products can be
-- managed from the dashboard and rendered identically on mobile.
ALTER TABLE "treasury_products" ADD COLUMN "riskLevel" TEXT NOT NULL DEFAULT 'Low';
ALTER TABLE "treasury_products" ADD COLUMN "auctionDate" DATE;
ALTER TABLE "treasury_products" ADD COLUMN "issueDate" DATE;
ALTER TABLE "treasury_products" ADD COLUMN "maturityDate" DATE;
ALTER TABLE "treasury_products" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'open';
