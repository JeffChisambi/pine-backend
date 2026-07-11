import { DomainEvent } from '../../../shared/base/domain-event.base';

export class KycDocumentUploadedEvent extends DomainEvent {
  readonly eventName = 'kyc.document.uploaded';
  constructor(
    public readonly applicationId: string,
    public readonly documentId: string,
    public readonly documentType: string,
  ) {
    super(applicationId);
  }
}
