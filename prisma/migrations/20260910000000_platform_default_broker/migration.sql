-- Pine has one broker partner, so investors no longer choose one in the app.
-- The platform admin sets the default once; registration places every new
-- investor with it. Existing investors are only moved when the admin asks.
ALTER TABLE "platform_config" ADD COLUMN "defaultBrokerId" UUID;
