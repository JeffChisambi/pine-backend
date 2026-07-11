# Auth Module

**Status:** ✅ Implemented

Enterprise-grade Authentication, Identity, and Session Management for Pine.
Architected like a brokerage platform — Auth answers "Who is this user?",
guards answer "Is this user allowed?", and security policies answer
"Can we trust this request?"

## Architecture

```
AuthService (orchestrator)
    ├── IdentityService    — user creation, credentials, profiles
    ├── SessionService     — session lifecycle, refresh token rotation
    ├── TokenService       — JWT signing/verification, blacklisting
    ├── OtpService         — Redis-backed OTP (never PostgreSQL)
    ├── DeviceService      — device trust, registration, revocation
    ├── PasswordService    — Argon2id hashing, complexity, history
    └── PinService         — transaction PIN (independent lockout)
```

## Token Architecture

| Token | Type | Lifetime | Storage |
|-------|------|----------|---------|
| Access | JWT (signed) | 15 minutes | Never stored server-side |
| Refresh | Opaque (64-byte hex) | 30 days | Hashed in PostgreSQL `sessions` |
| PIN Token | JWT | 5 minutes | Never stored server-side |

## Guards (Global)

1. **JwtAuthGuard** — every route authenticated by default; `@Public()` opts out
2. **RolesGuard** — `@Roles()` metadata check
3. **PermissionsGuard** — `@RequirePermissions()` metadata check
4. **PinGuard** — per-route, `@UseGuards(PinGuard)` on financial endpoints

## API Endpoints (17)

### Public
| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/auth/register` | Create account |
| `POST` | `/auth/login` | Login → tokens |
| `POST` | `/auth/refresh` | Rotate refresh token |
| `POST` | `/auth/forgot-password` | Request reset OTP |
| `POST` | `/auth/reset-password` | Reset via OTP |

### Authenticated
| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/auth/logout` | Revoke session |
| `POST` | `/auth/change-password` | Change password |
| `POST` | `/auth/pin/create` | Create transaction PIN |
| `POST` | `/auth/pin/verify` | Verify → pin-token |
| `POST` | `/auth/pin/change` | Change PIN |
| `POST` | `/auth/otp/send` | Send OTP |
| `POST` | `/auth/otp/verify` | Verify OTP |
| `GET` | `/auth/sessions` | List active sessions |
| `DELETE` | `/auth/sessions/:id` | Revoke session |
| `GET` | `/auth/devices` | List devices |
| `DELETE` | `/auth/devices/:id` | Revoke device |
| `GET` | `/auth/me` | Current user profile |

## RBAC

Guards check **permissions**, not role names.

```typescript
@RequirePermissions(Permission.KYC_APPROVE)
@Post('kyc/:id/approve')
```

See `constants/permissions.constant.ts` for the full role→permission map.

## Domain Events

```
auth.user.registered    auth.user.loggedin     auth.user.loggedout
auth.password.changed   auth.pin.created       auth.pin.changed
auth.otp.sent           auth.otp.verified      auth.device.new
auth.device.revoked     auth.session.created   auth.session.revoked
auth.token.refreshed    auth.account.locked
```

## Dependencies

```bash
npm install argon2 jsonwebtoken ioredis
npm install -D @types/jsonwebtoken
```
