import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../../../core/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../../core/types/request-context.types';
import { NotificationService } from '../services/notification.service';
import {
  MarkReadDto,
  UpdatePreferencesDto,
  NotificationQueryDto,
  RegisterDeviceDto,
  UnregisterDeviceDto,
} from '../dto/notification.dto';
import { DeviceService } from '../../auth/services/device.service';

/**
 * Notification Controller — in-app notification inbox & preferences.
 *
 * Endpoints:
 *   GET    /v1/notifications           → All notifications (paginated)
 *   GET    /v1/notifications/unread     → Unread only
 *   POST   /v1/notifications/read       → Mark one as read
 *   POST   /v1/notifications/read-all   → Mark all as read
 *   DELETE /v1/notifications/:id        → Delete a notification
 *   GET    /v1/notifications/preferences → Get preference settings
 *   PUT    /v1/notifications/preferences → Update preferences
 */
@ApiTags('notifications')
@ApiBearerAuth()
@Controller('notifications')
export class NotificationController {
  constructor(
    private readonly notificationService: NotificationService,
    private readonly deviceService: DeviceService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Get notifications',
    description: 'Returns paginated in-app notifications with unread count.',
  })
  @ApiResponse({ status: 200, description: 'Notification list with unread count' })
  async getNotifications(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: NotificationQueryDto,
  ) {
    return this.notificationService.getNotifications(
      user.id,
      query.limit ?? 30,
      query.offset ?? 0,
    );
  }

  @Get('unread')
  @ApiOperation({
    summary: 'Get unread notifications',
    description: 'Returns only unread in-app notifications.',
  })
  @ApiResponse({ status: 200, description: 'Unread notifications' })
  async getUnread(@CurrentUser() user: AuthenticatedUser) {
    return this.notificationService.getUnreadNotifications(user.id);
  }

  @Post('read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Mark notification as read',
    description: 'Marks a specific notification as read.',
  })
  @ApiResponse({ status: 200, description: 'Notification marked as read' })
  async markAsRead(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: MarkReadDto,
  ) {
    return this.notificationService.markAsRead(user.id, dto.notificationId);
  }

  @Post('read-all')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Mark all notifications as read',
    description: 'Marks all unread in-app notifications as read.',
  })
  @ApiResponse({ status: 200, description: 'All notifications marked as read' })
  async markAllAsRead(@CurrentUser() user: AuthenticatedUser) {
    return this.notificationService.markAllAsRead(user.id);
  }

  @Delete()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Clear all notifications',
    description: 'Removes every in-app notification from the inbox.',
  })
  @ApiResponse({ status: 200, description: 'All notifications cleared' })
  async clearAll(@CurrentUser() user: AuthenticatedUser) {
    return this.notificationService.clearAllNotifications(user.id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Delete a notification',
    description: 'Removes a notification from the inbox.',
  })
  @ApiParam({ name: 'id', description: 'Notification UUID' })
  @ApiResponse({ status: 200, description: 'Notification deleted' })
  async deleteNotification(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.notificationService.deleteNotification(user.id, id);
  }

  @Get('preferences')
  @ApiOperation({
    summary: 'Get notification preferences',
    description:
      'Returns per-category channel preferences (push, email, SMS). ' +
      'Security notifications are always enabled and cannot be modified.',
  })
  @ApiResponse({ status: 200, description: 'Preference settings per category' })
  async getPreferences(@CurrentUser() user: AuthenticatedUser) {
    return this.notificationService.getPreferences(user.id);
  }

  @Put('preferences')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Update notification preferences',
    description:
      'Update channel preferences for a notification category. ' +
      'Cannot modify SECURITY category (always enabled).',
  })
  @ApiResponse({ status: 200, description: 'Preferences updated' })
  async updatePreferences(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdatePreferencesDto,
  ) {
    return this.notificationService.updatePreferences(
      user.id,
      dto.category,
      { push: dto.push, email: dto.email, sms: dto.sms },
    );
  }

  // ── Push token registration ──────────────────────────────────

  @Post('devices')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Register push token',
    description: 'Saves the Expo push token for this device so the server can send push notifications.',
  })
  @ApiResponse({ status: 200, description: 'Token registered' })
  async registerDevice(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: RegisterDeviceDto,
  ) {
    await this.deviceService.updatePushToken(user.deviceId, dto.token);
    return { success: true };
  }

  @Delete('devices')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Unregister push token',
    description: 'Removes the push token for the current device (e.g. on logout).',
  })
  @ApiResponse({ status: 200, description: 'Token removed' })
  async unregisterDevice(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UnregisterDeviceDto,
  ) {
    await this.deviceService.updatePushToken(user.deviceId, null);
    return { success: true };
  }
}
