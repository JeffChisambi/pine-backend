import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Get,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { Public } from '../../../core/decorators/public.decorator';
import { CurrentUser } from '../../../core/decorators/current-user.decorator';
import { Roles } from '../../../core/decorators/roles.decorator';
import { Role } from '../../../core/constants/roles.constant';
import type { AuthenticatedUser, RequestWithUser } from '../../../core/types/request-context.types';
import { PrismaService } from '../../../infrastructure/database/prisma.service';
import { AdminAuthService } from '../services/admin-auth.service';
import { MfaService } from '../services/mfa.service';
import { AuditLogService } from '../../audit/services/audit-log.service';
import {
  AdminLoginDto,
  MfaVerifyDto,
  MfaSetupConfirmDto,
  MfaSetupDto,
  MfaResetDto,
  RecoveryCodeVerifyDto,
  RefreshTokenDto,
} from '../dto/admin.dto';

@ApiTags('admin')
@Controller('admin/auth')
export class AdminAuthController {
  constructor(
    private readonly adminAuthService: AdminAuthService,
    private readonly mfaService: MfaService,
    private readonly auditLogService: AuditLogService,
    private readonly prisma: PrismaService,
  ) {}

  @Post('login')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Admin login (Step 1)',
    description:
      'Validates email + password for staff accounts. Returns an MFA token ' +
      'and indicates whether MFA setup or verification is required.',
  })
  @ApiResponse({ status: 200, description: 'MFA required response' })
  async login(@Body() dto: AdminLoginDto, @Req() req: RequestWithUser) {
    return this.adminAuthService.login(
      dto.email,
      dto.password,
      req.ip,
      req.headers['user-agent'],
    );
  }

  @Post('mfa/verify')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Verify MFA code (Step 2)',
    description:
      'Verify a TOTP code from the authenticator app. On success, returns ' +
      'full JWT access + refresh tokens.',
  })
  @ApiResponse({ status: 200, description: 'Login successful with tokens' })
  async verifyMfa(@Body() dto: MfaVerifyDto, @Req() req: RequestWithUser) {
    return this.adminAuthService.completeMfaVerification(
      dto.mfaToken,
      dto.code,
      req.ip,
      req.headers['user-agent'],
    );
  }

  @Post('mfa/recovery')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Verify recovery code',
    description: 'Use a recovery code to complete MFA verification.',
  })
  @ApiResponse({ status: 200, description: 'Login successful with tokens' })
  async verifyRecoveryCode(
    @Body() dto: RecoveryCodeVerifyDto,
    @Req() req: RequestWithUser,
  ) {
    return this.adminAuthService.completeMfaVerification(
      dto.mfaToken,
      dto.code,
      req.ip,
      req.headers['user-agent'],
    );
  }

  @Post('mfa/setup')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Start MFA setup',
    description:
      'Generate TOTP secret and provisioning URI for QR code. ' +
      'Requires a valid MFA token from the login step.',
  })
  @ApiResponse({ status: 200, description: 'TOTP setup data' })
  async setupMfa(@Body() body: MfaSetupDto) {
    // The MFA token contains the userId — extract it via the auth service
    // We need to parse it manually since this is a public route
    const userId = this.extractUserIdFromMfaToken(body.mfaToken);

    const user = await this.getUserEmail(userId);
    return this.mfaService.generateSetup(userId, user.email!);
  }

  @Post('mfa/confirm-setup')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Confirm MFA setup',
    description:
      'Verify the first TOTP code to activate MFA. Returns recovery codes (shown once).',
  })
  @ApiResponse({ status: 200, description: 'MFA enabled + recovery codes' })
  async confirmMfaSetup(
    @Body() body: MfaSetupConfirmDto,
    @Req() req: RequestWithUser,
  ) {
    const userId = this.extractUserIdFromMfaToken(body.mfaToken);
    const result = await this.mfaService.confirmSetup(userId, body.code);

    await this.auditLogService.log({
      actorId: userId,
      action: 'MFA_ENABLED',
      resourceType: 'USER',
      resourceId: userId,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    // Issue tokens directly — the TOTP code was already verified by confirmSetup.
    // Calling completeMfaVerification would re-verify and fail if the time window rolled.
    const tokens = await this.adminAuthService.issueTokensForUser(
      userId,
      req.ip,
      req.headers['user-agent'],
    );

    return {
      ...tokens,
      recoveryCodes: result.recoveryCodes,
    };
  }

  @Get('mfa/status')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get MFA status for current user' })
  @ApiResponse({ status: 200, description: 'MFA status' })
  async getMfaStatus(@CurrentUser() user: AuthenticatedUser) {
    return this.mfaService.getMfaStatus(user.id);
  }

  @Post('mfa/reset')
  @ApiBearerAuth()
  @Roles(Role.SUPER_ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Reset another admin\'s MFA (Super Admin only)',
    description: 'Removes MFA configuration so the user must set up again.',
  })
  @ApiResponse({ status: 200, description: 'MFA reset' })
  async resetMfa(
    @Body() dto: MfaResetDto,
    @CurrentUser() admin: AuthenticatedUser,
    @Req() req: RequestWithUser,
  ) {
    await this.mfaService.resetMfa(dto.userId);

    await this.auditLogService.log({
      actorId: admin.id,
      actorRole: admin.role,
      action: 'MFA_RESET_BY_ADMIN',
      resourceType: 'USER',
      resourceId: dto.userId,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
      metadata: { reason: dto.reason },
    });

    return { message: 'MFA has been reset. User must set up MFA again on next login.' };
  }

  @Post('refresh')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Refresh access token' })
  @ApiResponse({ status: 200, description: 'New token pair' })
  async refresh(@Body() body: RefreshTokenDto) {
    return this.adminAuthService.refreshTokens(body.refreshToken);
  }

  @Post('logout')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Admin logout' })
  @ApiResponse({ status: 200, description: 'Session revoked' })
  async logout(@CurrentUser() user: AuthenticatedUser, @Req() req: RequestWithUser) {
    await this.adminAuthService.logout(user.sessionId, user.id, req.ip);
    return { message: 'Logged out successfully' };
  }

  // ── Helpers ──────────────────────────────────────────────────

  private extractUserIdFromMfaToken(token: string): string {
    try {
      const decoded = Buffer.from(token, 'base64url').toString();
      const [userId] = decoded.split(':');
      if (!userId) throw new Error('Invalid token');
      return userId;
    } catch {
      throw new Error('Invalid MFA token');
    }
  }

  private async getUserEmail(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });
    if (!user) {
      throw new Error(`User ${userId} not found when resolving email for audit log`);
    }
    return user;
  }
}
