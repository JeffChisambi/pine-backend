import { Body, Controller, Get, Put, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '../../../core/decorators/roles.decorator';
import { Role } from '../../../core/constants/roles.constant';
import { CurrentUser } from '../../../core/decorators/current-user.decorator';
import type { AuthenticatedUser, RequestWithUser } from '../../../core/types/request-context.types';
import { BrokerService } from '../services/broker.service';
import { SelectBrokerDto } from '../dto/broker.dto';

/**
 * Mobile-facing broker endpoints. The available broker list comes from
 * the backend (Super Admin configuration) — never hardcoded in the app.
 * Broker selection is persisted as a core account relationship on the
 * authenticated user; the server never trusts a client-supplied broker
 * for any financial operation.
 */
@ApiTags('brokers')
@ApiBearerAuth()
@Controller('brokers')
export class BrokersController {
  constructor(private readonly brokerService: BrokerService) {}

  @Get()
  @ApiOperation({ summary: 'List active brokers available for selection' })
  async listActiveBrokers() {
    return this.brokerService.listActiveBrokers();
  }

  @Get('me')
  @ApiOperation({ summary: "The authenticated investor's current broker" })
  async getMyBroker(@CurrentUser() user: AuthenticatedUser) {
    return this.brokerService.getUserBroker(user.id);
  }

  @Put('me')
  // CUSTOMER only: a staff/broker-admin account must never be able to
  // rewrite its own broker relationship — that would let a Broker A admin
  // re-point themselves at Broker B and widen their data scope.
  @Roles(Role.CUSTOMER)
  @ApiOperation({
    summary: 'Select (or change) the broker to trade with',
    description:
      'Changing an existing broker requires confirmChange=true and is blocked while ' +
      'the investor has funds, open orders, pending transactions, or holdings.',
  })
  async selectBroker(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: SelectBrokerDto,
    @Req() req: RequestWithUser,
  ) {
    return this.brokerService.selectBroker(user.id, dto, req.ip);
  }
}
