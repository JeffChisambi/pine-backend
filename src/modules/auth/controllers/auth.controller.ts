import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Ip,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Public } from '../../../core/decorators/public.decorator';
import { CurrentUser } from '../../../core/decorators/current-user.decorator';
import type { AuthenticatedUser, RequestWithUser } from '../../../core/types/request-context.types';
import { AuthService } from '../services/auth.service';
import { DeviceService } from '../services/device.service';
import { SessionService } from '../services/session.service';
import { RegisterDto } from '../dto/register.dto';
import { LoginDto } from '../dto/login.dto';
import { RefreshTokenDto } from '../dto/refresh-token.dto';
import {
  ChangePasswordDto,
  ChangePinDto,
  CreatePinDto,
  ForgotPasswordDto,
  ResetPasswordDto,
  SendOtpDto,
  VerifyOtpDto,
  VerifyPinDto,
} from '../dto/auth-operations.dto';
import type { AuthResponseDto } from '../dto/auth-response.dto';

/**
 * Auth controller — thin HTTP layer. All business logic lives
 * in AuthService (orchestrator) and its sub-services.
 *
 * Route prefix: /auth (combined with the global v1 prefix → /v1/auth)
 *
 * Public routes:
 *   POST /auth/register
 *   POST /auth/login
 *   POST /auth/refresh
 *   POST /auth/forgot-password
 *   POST /auth/reset-password
 *
 * Authenticated routes (all others):
 *   POST /auth/logout
 *   POST /auth/change-password
 *   POST /auth/pin/create
 *   POST /auth/pin/verify
 *   POST /auth/pin/change
 *   POST /auth/otp/send
 *   POST /auth/otp/verify
 *   GET  /auth/sessions
 *   DELETE /auth/sessions/:id
 *   GET  /auth/devices
 *   DELETE /auth/devices/:id
 *   GET  /auth/me
 */
@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly deviceService: DeviceService,
    private readonly sessionService: SessionService,
  ) {}

  // ──────────────────────────────────────────────────────────────
  // Public Routes
  // ──────────────────────────────────────────────────────────────

  @Public()
  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Register a new account' })
  @ApiResponse({ status: 201, description: 'Account created, tokens returned' })
  @ApiResponse({ status: 409, description: 'Phone or email already registered' })
  async register(
    @Body() dto: RegisterDto,
    @Ip() ip: string,
    @Req() req: RequestWithUser,
  ): Promise<AuthResponseDto> {
    return this.authService.register(dto, ip, req.headers['user-agent']);
  }

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Login with phone and password' })
  @ApiResponse({ status: 200, description: 'Authentication successful' })
  @ApiResponse({ status: 401, description: 'Invalid credentials' })
  async login(
    @Body() dto: LoginDto,
    @Ip() ip: string,
    @Req() req: RequestWithUser,
  ): Promise<AuthResponseDto> {
    return this.authService.login(dto, ip, req.headers['user-agent']);
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Refresh access token using refresh token',
    description: 'Rotates the refresh token — the old one is immediately invalidated.',
  })
  @ApiResponse({ status: 200, description: 'New token pair issued' })
  @ApiResponse({ status: 401, description: 'Invalid or expired refresh token' })
  async refresh(@Body() dto: RefreshTokenDto): Promise<AuthResponseDto> {
    return this.authService.refresh(dto.refreshToken);
  }

  @Public()
  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Request password reset OTP',
    description: 'Sends an OTP to the phone number. Always returns success to prevent user enumeration.',
  })
  async forgotPassword(
    @Body() dto: ForgotPasswordDto,
  ): Promise<{ message: string }> {
    return this.authService.forgotPassword(dto.phone);
  }

  @Public()
  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reset password using OTP' })
  async resetPassword(
    @Body() dto: ResetPasswordDto,
  ): Promise<{ message: string }> {
    return this.authService.resetPassword(dto.phone, dto.otp, dto.newPassword);
  }

  // ──────────────────────────────────────────────────────────────
  // Authenticated Routes
  // ──────────────────────────────────────────────────────────────

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Logout — revokes current session' })
  async logout(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ message: string }> {
    await this.authService.logout(user.id, user.sessionId);
    return { message: 'Logged out successfully' };
  }

  @Post('change-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Change password (requires current password)' })
  async changePassword(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ChangePasswordDto,
  ): Promise<{ message: string }> {
    return this.authService.changePassword(
      user.id,
      user.sessionId,
      dto.currentPassword,
      dto.newPassword,
    );
  }

  // ── PIN ───────────────────────────────────────────────────────

  @Post('pin/create')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a transaction PIN' })
  async createPin(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreatePinDto,
  ): Promise<{ message: string }> {
    return this.authService.createPin(user.id, dto.pin);
  }

  @Post('pin/verify')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Verify PIN — returns a short-lived pin-token',
    description: 'Use the returned pinToken in the x-pin-token header for financial actions.',
  })
  async verifyPin(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: VerifyPinDto,
  ): Promise<{ pinToken: string }> {
    return this.authService.verifyPin(user.id, user.sessionId, dto.pin);
  }

  @Post('pin/change')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Change transaction PIN' })
  async changePin(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ChangePinDto,
  ): Promise<{ message: string }> {
    return this.authService.changePin(user.id, dto.currentPin, dto.newPin);
  }

  // ── OTP ───────────────────────────────────────────────────────

  @Post('otp/send')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Send an OTP to phone or email' })
  async sendOtp(
    @Body() dto: SendOtpDto,
  ): Promise<{ message: string; expiresInSeconds: number }> {
    return this.authService.sendOtp(dto.destination, dto.purpose);
  }

  @Post('otp/verify')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Verify an OTP code' })
  async verifyOtp(
    @Body() dto: VerifyOtpDto,
  ): Promise<{ verified: boolean }> {
    return this.authService.verifyOtp(dto.destination, dto.purpose, dto.code);
  }

  // ── Sessions ──────────────────────────────────────────────────

  @Get('sessions')
  @ApiOperation({
    summary: 'List active sessions',
    description: 'Returns all active (non-revoked, non-expired) sessions for the current user.',
  })
  async listSessions(@CurrentUser() user: AuthenticatedUser) {
    const sessions = await this.sessionService.listActiveSessions(user.id);
    return {
      sessions: sessions.map((s) => ({
        ...s,
        isCurrent: s.id === user.sessionId,
      })),
      count: sessions.length,
    };
  }

  @Delete('sessions/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Revoke a session by ID' })
  async revokeSession(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') sessionId: string,
  ): Promise<{ message: string }> {
    await this.sessionService.revokeSession(
      sessionId,
      user.id,
      'user_revoked',
    );
    return { message: 'Session revoked' };
  }

  // ── Devices ───────────────────────────────────────────────────

  @Get('devices')
  @ApiOperation({ summary: 'List all devices associated with the account' })
  async listDevices(@CurrentUser() user: AuthenticatedUser) {
    const devices = await this.deviceService.listByUserId(user.id);
    return {
      devices: devices.map((d) => ({
        ...d,
        isCurrent: d.id === user.deviceId,
      })),
      count: devices.length,
    };
  }

  @Delete('devices/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Revoke a device — all sessions on this device are also revoked',
  })
  async revokeDevice(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') deviceId: string,
  ): Promise<{ message: string }> {
    await this.deviceService.revokeDevice(user.id, deviceId);
    return { message: 'Device revoked' };
  }

  // ── Profile ───────────────────────────────────────────────────

  @Get('me')
  @ApiOperation({ summary: 'Get current user profile' })
  async getProfile(@CurrentUser() user: AuthenticatedUser) {
    return this.authService.getProfile(user.id);
  }
}
