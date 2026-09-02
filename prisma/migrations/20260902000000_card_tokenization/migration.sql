-- Card-on-file tokenization: store a merchant-scoped gateway token instead of a PAN.
-- Existing rows keep their encrypted PAN until they are re-tokenised or deleted.

ALTER TABLE "saved_cards" ALTER COLUMN "cardNumberEncrypted" DROP NOT NULL;
ALTER TABLE "saved_cards" ADD COLUMN "gatewayToken" TEXT;
ALTER TABLE "saved_cards" ADD COLUMN "tokenBrokerId" UUID;
