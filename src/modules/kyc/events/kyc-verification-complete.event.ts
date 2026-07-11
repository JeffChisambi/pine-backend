import { DomainEvent } from '../../../shared/base/domain-event.base';

export class KycVerificationCompleteEvent extends DomainEvent {
  readonly eventName = 'kyc.verification.complete';
  constructor(
    public readonly applicationId: string,
    public readonly userId: string,
    public readonly decision: 'APPROVED' | 'MANUAL_REVIEW' | 'REJECTED',
    public readonly confidenceScore: number,
  ) {
    super(applicationId);
  }
}
