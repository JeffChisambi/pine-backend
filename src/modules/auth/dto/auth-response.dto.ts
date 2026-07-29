import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class AuthUserDto {
  @ApiProperty() id: string;
  @ApiProperty() phone: string;
  @ApiPropertyOptional() email: string | null;
  @ApiProperty() firstName: string;
  @ApiProperty() lastName: string;
  @ApiProperty() role: string;
  @ApiProperty() kycStatus: string;
  @ApiProperty() hasPinSet: boolean;
  @ApiPropertyOptional() avatarUrl: string | null;
  @ApiPropertyOptional() isActive?: boolean;
  @ApiProperty() createdAt: string;
}

/**
 * Standard auth response returned after login, registration,
 * and token refresh. Contains everything the mobile app needs
 * to authenticate subsequent requests.
 */
export class AuthResponseDto {
  @ApiProperty({ description: 'JWT access token (short-lived)' })
  accessToken: string;

  @ApiProperty({ description: 'Opaque refresh token (long-lived, rotate on use)' })
  refreshToken: string;

  @ApiProperty({ description: 'Access token expiry in seconds' })
  expiresIn: number;

  @ApiProperty({ description: 'Token type, always Bearer' })
  tokenType: string = 'Bearer';

  @ApiProperty({ description: 'Authenticated user profile' })
  user: AuthUserDto;
}
