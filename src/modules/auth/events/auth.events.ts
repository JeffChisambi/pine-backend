import { DomainEvent } from '../../../shared/base/domain-event.base';

export class UserRegisteredEvent extends DomainEvent {
  readonly eventName = 'auth.user.registered';
  constructor(
    public readonly userId: string,
    public readonly phone: string,
  ) {
    super(userId);
  }
}

export class UserLoggedInEvent extends DomainEvent {
  readonly eventName = 'auth.user.loggedin';
  constructor(
    public readonly userId: string,
    public readonly sessionId: string,
    public readonly deviceId: string,
    public readonly isNewDevice: boolean,
    public readonly ipAddress?: string,
  ) {
    super(userId);
  }
}

export class UserLoggedOutEvent extends DomainEvent {
  readonly eventName = 'auth.user.loggedout';
  constructor(
    public readonly userId: string,
    public readonly sessionId: string,
  ) {
    super(userId);
  }
}

export class PasswordChangedEvent extends DomainEvent {
  readonly eventName = 'auth.password.changed';
  constructor(public readonly userId: string) {
    super(userId);
  }
}

export class PinCreatedEvent extends DomainEvent {
  readonly eventName = 'auth.pin.created';
  constructor(public readonly userId: string) {
    super(userId);
  }
}

export class PinChangedEvent extends DomainEvent {
  readonly eventName = 'auth.pin.changed';
  constructor(public readonly userId: string) {
    super(userId);
  }
}

export class OtpSentEvent extends DomainEvent {
  readonly eventName = 'auth.otp.sent';
  constructor(
    public readonly destination: string,
    public readonly purpose: string,
  ) {
    super(destination);
  }
}

export class OtpVerifiedEvent extends DomainEvent {
  readonly eventName = 'auth.otp.verified';
  constructor(
    public readonly destination: string,
    public readonly purpose: string,
  ) {
    super(destination);
  }
}

export class DeviceNewEvent extends DomainEvent {
  readonly eventName = 'auth.device.new';
  constructor(
    public readonly userId: string,
    public readonly deviceId: string,
    public readonly platform: string,
  ) {
    super(userId);
  }
}

export class DeviceRevokedEvent extends DomainEvent {
  readonly eventName = 'auth.device.revoked';
  constructor(
    public readonly userId: string,
    public readonly deviceId: string,
  ) {
    super(userId);
  }
}

export class SessionCreatedEvent extends DomainEvent {
  readonly eventName = 'auth.session.created';
  constructor(
    public readonly userId: string,
    public readonly sessionId: string,
    public readonly deviceId: string,
  ) {
    super(userId);
  }
}

export class SessionRevokedEvent extends DomainEvent {
  readonly eventName = 'auth.session.revoked';
  constructor(
    public readonly userId: string,
    public readonly sessionId: string,
    public readonly reason: string,
  ) {
    super(userId);
  }
}

export class TokenRefreshedEvent extends DomainEvent {
  readonly eventName = 'auth.token.refreshed';
  constructor(
    public readonly userId: string,
    public readonly sessionId: string,
  ) {
    super(userId);
  }
}

export class AccountLockedEvent extends DomainEvent {
  readonly eventName = 'auth.account.locked';
  constructor(
    public readonly userId: string,
    public readonly reason: string,
  ) {
    super(userId);
  }
}
