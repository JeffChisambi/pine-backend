-- Broker-configurable mobile app brand theme (single active row).

-- CreateTable
CREATE TABLE "mobile_themes" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "colors" JSONB NOT NULL,
    "updatedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mobile_themes_pkey" PRIMARY KEY ("id")
);
