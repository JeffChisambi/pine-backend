import { DomainEvent } from '../../../shared/base/domain-event.base';

export class KycApprovedEvent extends DomainEvent {
  readonly eventName = 'kyc.approved';
  constructor(
    public readonly applicationId: string,
    public readonly userId: string,
  ) {
    super(applicationId);
  }
}
