-- Editorial news articles for the mobile News tab, managed from the dashboard.
-- `body` is an ordered text[] of paragraphs (mobile renders one <Text> each).
CREATE TABLE "news_articles" (
    "id" UUID NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'Markets',
    "title" TEXT NOT NULL,
    "summary" TEXT,
    "body" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "source" TEXT NOT NULL DEFAULT '',
    "imageUrl" TEXT,
    "featured" BOOLEAN NOT NULL DEFAULT false,
    "isPublished" BOOLEAN NOT NULL DEFAULT true,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "authorId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "news_articles_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "news_articles_isPublished_publishedAt_idx" ON "news_articles"("isPublished", "publishedAt");
CREATE INDEX "news_articles_category_idx" ON "news_articles"("category");
