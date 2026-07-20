-- Create watchlist_entries table
CREATE TABLE IF NOT EXISTS "watchlist_entries" (
    "id"        UUID        NOT NULL DEFAULT gen_random_uuid(),
    "userId"    UUID        NOT NULL,
    "stockId"   UUID        NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "watchlist_entries_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "watchlist_entries_userId_fkey"
        FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE,
    CONSTRAINT "watchlist_entries_stockId_fkey"
        FOREIGN KEY ("stockId") REFERENCES "stocks"("id") ON DELETE CASCADE,
    CONSTRAINT "watchlist_entries_userId_stockId_key"
        UNIQUE ("userId", "stockId")
);

CREATE INDEX IF NOT EXISTS "watchlist_entries_userId_idx" ON "watchlist_entries"("userId");
