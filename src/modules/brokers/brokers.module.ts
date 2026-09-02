import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AuditModule } from '../audit/audit.module';
import { MastercardGatewayModule } from '../mastercard-gateway/mastercard-gateway.module';
import { BrokerService } from './services/broker.service';
import { BrokerAdminService } from './services/broker-admin.service';
import { BrokerPaymentConfigService } from './services/broker-payment-config.service';
import { BrokerSecretsService } from './services/broker-secrets.service';
import { BrokerScopeService } from './services/broker-scope.service';
import { FeePolicyService } from './services/fee-policy.service';
import { PlatformFeeService } from './services/platform-fee.service';
import { RiskPolicyService } from './services/risk-policy.service';
import { AdminBrokersController } from './controllers/admin-brokers.controller';
import { BrokersController } from './controllers/brokers.controller';
import { AdminFeesController } from './controllers/admin-fees.controller';
import { AdminRiskController } from './controllers/admin-risk.controller';

/**
 * BrokersModule — multi-broker tenancy:
 *   - Super Admin broker management (CRUD, admins, payment/API config)
 *   - Mobile broker list + investor broker selection
 *   - BrokerScopeService (server-side broker-scoped authorization)
 *   - BrokerPaymentConfigService (per-broker gateway credential resolution
 *     and the Super Admin MPGS connection/credential test)
 *
 * MastercardGatewayModule is imported for the credential test. It only
 * depends on ConfigModule, so no dependency cycle is introduced.
 */
@Module({
  imports: [AuthModule, AuditModule, MastercardGatewayModule],
  controllers: [AdminBrokersController, BrokersController, AdminFeesController, AdminRiskController],
  providers: [
    BrokerService,
    BrokerAdminService,
    BrokerPaymentConfigService,
    BrokerSecretsService,
    BrokerScopeService,
    FeePolicyService,
    RiskPolicyService,
    PlatformFeeService,
  ],
  exports: [
    BrokerScopeService,
    BrokerPaymentConfigService,
    BrokerAdminService,
    BrokerService,
    FeePolicyService,
    RiskPolicyService,
    PlatformFeeService,
  ],
})
export class BrokersModule {}
