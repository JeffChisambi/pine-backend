-- Capture date of birth + gender at registration so the KYC pipeline can
-- reconcile OCR/MRZ extraction against trusted, user-entered values.
ALTER TABLE "users" ADD COLUMN "dateOfBirth" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN "gender" TEXT;
