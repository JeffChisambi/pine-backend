-- CreateEnum
CREATE TYPE "TreasuryInvestmentStatus" AS ENUM ('PENDING', 'ACTIVE', 'MATURED', 'CANCELLED');

-- CreateTable
CREATE TABLE "treasury_products" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "label" TEXT NOT NULL,
    "tenorDays" INTEGER NOT NULL,
    "yieldPercent" DECIMAL(8,4) NOT NULL,
    "minAmount" DECIMAL(18,4) NOT NULL,
    "maxAmount" DECIMAL(18,4),
    "currency" TEXT NOT NULL DEFAULT 'MWK',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "treasury_products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "treasury_investments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "userId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "status" "TreasuryInvestmentStatus" NOT NULL DEFAULT 'PENDING',
    "amount" DECIMAL(18,4) NOT NULL,
    "yieldPercent" DECIMAL(8,4) NOT NULL,
    "earnings" DECIMAL(18,4) NOT NULL,
    "maturityValue" DECIMAL(18,4) NOT NULL,
    "maturityDate" DATE NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "treasury_investments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "treasury_investments_userId_idx" ON "treasury_investments"("userId");

-- CreateIndex
CREATE INDEX "treasury_investments_status_idx" ON "treasury_investments"("status");

-- AddForeignKey
ALTER TABLE "treasury_investments" ADD CONSTRAINT "treasury_investments_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "treasury_investments" ADD CONSTRAINT "treasury_investments_productId_fkey" FOREIGN KEY ("productId") REFERENCES "treasury_products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
