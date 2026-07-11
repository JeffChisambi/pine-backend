import { DomainEvent } from '../../../shared/base/domain-event.base';

export class KycRejectedEvent extends DomainEvent {
  readonly eventName = 'kyc.rejected';
  constructor(
    public readonly applicationId: string,
    public readonly userId: string,
    public readonly reason: string,
  ) {
    super(applicationId);
  }
}
