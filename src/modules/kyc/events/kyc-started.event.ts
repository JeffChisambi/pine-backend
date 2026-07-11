import { DomainEvent } from '../../../shared/base/domain-event.base';

export class KycStartedEvent extends DomainEvent {
  readonly eventName = 'kyc.started';
  constructor(
    public readonly applicationId: string,
    public readonly userId: string,
  ) {
    super(applicationId);
  }
}
