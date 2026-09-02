-- Per-broker 3-D Secure policy. Off by default: enabling it refuses any card
-- deposit that cannot be authenticated, which shifts chargeback liability to
-- the issuer (the merchant of record on every deposit is the broker).
ALTER TABLE "broker_payment_configs" ADD COLUMN "require3ds" BOOLEAN NOT NULL DEFAULT false;
