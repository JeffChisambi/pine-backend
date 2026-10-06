-- Imported news carries a pointer back to the original. The unique index is
-- the import's dedupe: running the weekly sync over listings it has already
-- seen inserts nothing. Nullable, so every article written by hand is
-- untouched.
ALTER TABLE "news_articles" ADD COLUMN "origin" TEXT;
ALTER TABLE "news_articles" ADD COLUMN "sourceUrl" TEXT;
CREATE UNIQUE INDEX "news_articles_sourceUrl_key" ON "news_articles"("sourceUrl");
