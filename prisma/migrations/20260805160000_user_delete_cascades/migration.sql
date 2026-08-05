-- Fix user deletion: several relations referenced users with the default
-- RESTRICT, so deleting a user who had any order/holding/payment/treasury
-- investment/audit-log failed with a foreign-key violation (the dashboard
-- "Delete user" button appeared to do nothing). Cascade owned records; null
-- out audit actor + KYC reviewer so history/records survive the deletion.

-- Orders → cascade
ALTER TABLE "orders" DROP CONSTRAINT IF EXISTS "orders_userId_fkey";
ALTER TABLE "orders" ADD CONSTRAINT "orders_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Holdings → cascade
ALTER TABLE "holdings" DROP CONSTRAINT IF EXISTS "holdings_userId_fkey";
ALTER TABLE "holdings" ADD CONSTRAINT "holdings_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Payments → cascade
ALTER TABLE "payments" DROP CONSTRAINT IF EXISTS "payments_userId_fkey";
ALTER TABLE "payments" ADD CONSTRAINT "payments_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Treasury investments → cascade
ALTER TABLE "treasury_investments" DROP CONSTRAINT IF EXISTS "treasury_investments_userId_fkey";
ALTER TABLE "treasury_investments" ADD CONSTRAINT "treasury_investments_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Audit logs → keep the row, null the actor (audit history survives)
ALTER TABLE "audit_logs" DROP CONSTRAINT IF EXISTS "audit_logs_actorId_fkey";
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actorId_fkey"
  FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- KYC applications reviewer → keep the application, null the reviewer
ALTER TABLE "kyc_applications" DROP CONSTRAINT IF EXISTS "kyc_applications_reviewedById_fkey";
ALTER TABLE "kyc_applications" ADD CONSTRAINT "kyc_applications_reviewedById_fkey"
  FOREIGN KEY ("reviewedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
