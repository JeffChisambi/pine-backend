-- AlterEnum
ALTER TYPE "Role" ADD VALUE 'BROKER';

-- DropForeignKey
ALTER TABLE "watchlist_entries" DROP CONSTRAINT "watchlist_entries_stockId_fkey";

-- DropForeignKey
ALTER TABLE "watchlist_entries" DROP CONSTRAINT "watchlist_entries_userId_fkey";

-- AlterTable
ALTER TABLE "news_articles" ALTER COLUMN "body" DROP DEFAULT;

-- AlterTable
ALTER TABLE "treasury_investments" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "treasury_products" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "watchlist_entries" ALTER COLUMN "id" DROP DEFAULT;

-- CreateTable
CREATE TABLE "saved_cards" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "last4" VARCHAR(4) NOT NULL,
    "cardBrand" VARCHAR(20) NOT NULL,
    "cardholderName" TEXT NOT NULL,
    "expiryMonth" VARCHAR(2) NOT NULL,
    "expiryYear" VARCHAR(4) NOT NULL,
    "cardNumberEncrypted" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "saved_cards_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "saved_cards_userId_idx" ON "saved_cards"("userId");

-- AddForeignKey
ALTER TABLE "saved_cards" ADD CONSTRAINT "saved_cards_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "watchlist_entries" ADD CONSTRAINT "watchlist_entries_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "watchlist_entries" ADD CONSTRAINT "watchlist_entries_stockId_fkey" FOREIGN KEY ("stockId") REFERENCES "stocks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
