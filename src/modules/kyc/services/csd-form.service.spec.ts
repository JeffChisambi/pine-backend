import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { CsdFormService } from './csd-form.service';
import { KycReconciliationService } from './kyc-reconciliation.service';
import type { PrismaService } from '../../../infrastructure/database/prisma.service';

const makeService = (prisma: PrismaService) =>
  new CsdFormService(prisma, new KycReconciliationService());

/** Minimal Prisma mock covering the two queries the service makes. */
function prismaMock(overrides?: { bank?: unknown }): PrismaService {
  return {
    kycApplication: {
      findUnique: async () => ({
        id: 'app-1234-5678',
        userId: 'user-1',
        nationalIdNumber: 'D23145890',
        dateOfBirth: new Date(Date.UTC(1979, 2, 12)),
        addressLine1: 'P.O. Box 1234',
        addressLine2: 'Area 47, Sector 3',
        city: 'Lilongwe',
        district: 'Lilongwe',
        ocrExtractedData: {
          fullName: { value: 'Thelmer Chisambi', confidence: 0.9 },
          gender: { value: 'M', confidence: 0.95 },
          nationality: { value: 'MWI', confidence: 0.95 },
          _extractedAddress: {
            formatted: 'P.O. Box 1234, Area 47, Sector 3, Lilongwe',
            confidence: 0.8,
          },
        },
        user: {
          id: 'user-1',
          firstName: 'Thelmer',
          lastName: 'Chisambi',
          email: 'thelmer@example.com',
          phone: '+265990342842',
          dateOfBirth: new Date(Date.UTC(1979, 2, 12)),
          gender: 'M',
        },
      }),
      update: async () => ({}),
    },
    linkedBank: {
      findFirst: async () =>
        overrides && 'bank' in overrides
          ? overrides.bank
          : {
              bankName: 'National Bank of Malawi',
              accountName: 'Thelmer Chisambi',
              accountNumberMasked: '****4321',
            },
    },
  } as unknown as PrismaService;
}

describe('CsdFormService', () => {
  it('generates a 2-page PDF with the applicant data', async () => {
    const service = makeService(prismaMock());
    const pdf = await service.generateForApplication('app-1234-5678');

    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    const doc = await PDFDocument.load(pdf);
    expect(doc.getPageCount()).toBe(2);
    // A generated PDF for a filled form should be a real document, not a stub
    expect(pdf.length).toBeGreaterThan(4000);
  });

  it('still generates when the user has no linked bank', async () => {
    const service = makeService(prismaMock({ bank: null }));
    const pdf = await service.generateForApplication('app-1234-5678');
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  });
});
