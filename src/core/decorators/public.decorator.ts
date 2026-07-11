import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Marks a route as not requiring authentication. The global JWT guard
 * (registered in Phase 2 via `APP_GUARD`) checks for this metadata and
 * skips itself when present. Everything is authenticated by default —
 * this is an explicit, auditable opt-out, not the other way around.
 *
 * @example
 * @Public()
 * @Post('login')
 * login(@Body() dto: LoginDto) { ... }
 */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);
