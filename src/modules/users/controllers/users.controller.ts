import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConsumes,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../../../core/decorators/current-user.decorator';
import type { AuthenticatedUser, RequestWithUser } from '../../../core/types/request-context.types';
import { PinGuard } from '../../auth/guards/pin.guard';
import { ProfileService } from '../services/profile.service';
import { UserPreferenceService } from '../services/preference.service';
import { IdentityFacade } from '../services/identity-facade.service';
import { AccountService } from '../services/account.service';
import { UpdateProfileDto, UpdatePreferencesDto } from '../dto/users.dto';

/**
 * Users Controller — intentionally small.
 *
 * What IS here:
 *   GET    /v1/users/me           → Profile
 *   PATCH  /v1/users/me           → Update profile
 *   PUT    /v1/users/avatar       → Upload avatar
 *   GET    /v1/users/preferences  → Get settings
 *   PUT    /v1/users/preferences  → Update settings
 *   GET    /v1/users/identity     → Home screen aggregation
 *
 * What is NOT here (and should never be):
 *   /users/change-password   → Auth module
 *   /users/change-pin        → Auth module
 *   /users/link-bank         → Wallet module
 *   /users/kyc               → KYC module
 *   /users/portfolio         → Portfolio module
 */
@ApiTags('users')
@ApiBearerAuth()
@Controller('users')
export class UsersController {
  constructor(
    private readonly profileService: ProfileService,
    private readonly preferenceService: UserPreferenceService,
    private readonly identityFacade: IdentityFacade,
    private readonly accountService: AccountService,
  ) {}

  // ── Profile ─────────────────────────────────────────────────

  @Get('me')
  @ApiOperation({
    summary: 'Get current user profile',
    description:
      'Returns the authenticated user\'s profile: name, phone, email, ' +
      'avatar, KYC status, and profile completion percentage.',
  })
  @ApiResponse({ status: 200, description: 'User profile' })
  async getProfile(@CurrentUser() user: AuthenticatedUser) {
    return this.profileService.getProfile(user.id);
  }

  @Patch('me')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Update profile',
    description:
      'Update the user\'s display name and email. ' +
      'Cannot change phone number (that requires re-verification via Auth).',
  })
  @ApiResponse({ status: 200, description: 'Updated profile' })
  async updateProfile(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateProfileDto,
  ) {
    return this.profileService.updateProfile(user.id, dto);
  }

  @Delete('me')
  @UseGuards(PinGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Close (delete) my account',
    description:
      'Permanently deactivates the account and anonymizes personal data ' +
      '(name, contact, KYC details and document images, avatar). Financial, ' +
      'ledger and audit records are retained for compliance. PIN-verified: ' +
      'requires a valid x-pin-token header. This cannot be undone from the app.',
  })
  @ApiResponse({ status: 200, description: 'Account closed and anonymized' })
  async deleteAccount(
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: RequestWithUser,
  ) {
    return this.accountService.deleteOwnAccount(user.id, {
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });
  }

  @Put('avatar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Upload avatar',
    description:
      'Upload or replace the user\'s profile picture. ' +
      'Accepts a storage key from the client-side upload.',
  })
  @ApiResponse({ status: 200, description: 'Avatar URL' })
  async uploadAvatar(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: { avatarKey: string },
  ) {
    return this.profileService.updateAvatar(user.id, body.avatarKey);
  }

  // ── Preferences ─────────────────────────────────────────────

  @Get('preferences')
  @ApiOperation({
    summary: 'Get user preferences',
    description:
      'Returns all user settings: language, timezone, country, ' +
      'notification toggles, marketing consent, and accessibility.',
  })
  @ApiResponse({ status: 200, description: 'User preferences' })
  async getPreferences(@CurrentUser() user: AuthenticatedUser) {
    return this.preferenceService.getPreferences(user.id);
  }

  @Put('preferences')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Update preferences',
    description:
      'Update any user settings. Only include the fields you want to change.',
  })
  @ApiResponse({ status: 200, description: 'Updated preferences' })
  async updatePreferences(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdatePreferencesDto,
  ) {
    return this.preferenceService.updatePreferences(user.id, dto);
  }

  // ── Identity ────────────────────────────────────────────────

  @Get('identity')
  @ApiOperation({
    summary: 'Get identity summary (home screen)',
    description:
      'Returns an aggregated summary for the mobile app home screen: ' +
      'profile, verification status, wallet balance, holdings count, ' +
      'unread notifications, and trading eligibility. ' +
      'This is a single call that reads from Auth, KYC, Wallet, ' +
      'Portfolio, and Notifications — so the app doesn\'t need 5 requests.',
  })
  @ApiResponse({ status: 200, description: 'Identity summary' })
  async getIdentity(@CurrentUser() user: AuthenticatedUser) {
    return this.identityFacade.getIdentitySummary(user.id);
  }
}
