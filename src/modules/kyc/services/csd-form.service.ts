import { Injectable, Logger } from '@nestjs/common';
import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb } from 'pdf-lib';
import { PrismaService } from '../../../infrastructure/database/prisma.service';
import {
  KycReconciliationService,
  type CsdFieldValues,
} from './kyc-reconciliation.service';

/**
 * Generates a filled Reserve Bank of Malawi "Securities Account Opening/Update
 * Form (CSD)" for a completed KYC application, so the broker can open the
 * client's CSD account without re-keying any data.
 *
 * The official form is a flat (non-AcroForm) PDF, so instead of overlaying
 * text at fragile hard-coded coordinates we regenerate the form faithfully —
 * same sections, same wording, same declaration clauses — with the applicant's
 * verified KYC data typed into the blanks in BLOCK LETTERS.
 *
 * Data sources, in trust order:
 *   1. OCR/MRZ-verified identity fields from the KYC pipeline
 *   2. The applicant's profile (phone, email, names)
 *   3. Extracted proof-of-residency address
 *   4. Primary linked bank for the Dividend Disposal instruction
 *      (account number is masked — broker confirms the full number at signing)
 */
const CSD_OVERRIDES_KEY = '_csdOverrides';

@Injectable()
export class CsdFormService {
  private readonly logger = new Logger(CsdFormService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly reconciliation: KycReconciliationService,
  ) {}

  /**
   * Resolve the CSD form's field values for an application: reconciled KYC data
   * (registration-anchored) with any saved broker overrides applied on top.
   * This is what the editable dashboard form binds to.
   */
  async resolveFields(applicationId: string): Promise<CsdFieldValues> {
    const { input, bank, overrides } = await this.load(applicationId);
    return this.reconciliation.resolveCsdFields(input, bank, overrides);
  }

  /** Persist broker field overrides for an application's CSD form. */
  async saveOverrides(
    applicationId: string,
    overrides: Record<string, string>,
  ): Promise<CsdFieldValues> {
    const app = await this.prisma.kycApplication.findUnique({
      where: { id: applicationId },
      select: { ocrExtractedData: true },
    });
    if (!app) throw new Error('KYC application not found');

    const existing = (app.ocrExtractedData ?? {}) as Record<string, unknown>;
    // Keep only non-empty string overrides; empty string clears a field back
    // to the reconciled default.
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(overrides)) {
      if (typeof v === 'string' && v.trim() !== '') clean[k] = v;
    }

    await this.prisma.kycApplication.update({
      where: { id: applicationId },
      data: { ocrExtractedData: { ...existing, [CSD_OVERRIDES_KEY]: clean } as any },
    });

    return this.resolveFields(applicationId);
  }

  async generateForApplication(
    applicationId: string,
    /** One-off overrides merged on top of any saved overrides. */
    extraOverrides: Record<string, string> = {},
  ): Promise<Buffer> {
    const { input, bank, overrides } = await this.load(applicationId);
    const fields = this.reconciliation.resolveCsdFields(input, bank, {
      ...overrides,
      ...extraOverrides,
    });
    return this.render({ ...fields, date: this.formatDate(new Date()), applicationId });
  }

  /** Shared loader: application + user + primary bank + saved overrides. */
  private async load(applicationId: string): Promise<{
    input: Parameters<KycReconciliationService['resolveCsdFields']>[0];
    bank: { bankName?: string | null; accountName?: string | null; accountNumberMasked?: string | null } | null;
    overrides: Record<string, string>;
  }> {
    const app = await this.prisma.kycApplication.findUnique({
      where: { id: applicationId },
      include: {
        user: {
          select: {
            firstName: true, lastName: true, email: true, phone: true,
            dateOfBirth: true, gender: true,
          },
        },
      },
    });
    if (!app) throw new Error('KYC application not found');

    const bank = await this.prisma.linkedBank.findFirst({
      where: { userId: app.userId, deletedAt: null },
      orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
    });

    const ocrData = (app.ocrExtractedData ?? {}) as Record<string, unknown>;
    const overrides = (ocrData[CSD_OVERRIDES_KEY] as Record<string, string>) ?? {};

    return {
      input: {
        user: {
          firstName: app.user.firstName,
          lastName: app.user.lastName,
          email: app.user.email,
          phone: app.user.phone,
          dateOfBirth: app.user.dateOfBirth,
          gender: app.user.gender,
        },
        application: {
          nationalIdNumber: app.nationalIdNumber,
          dateOfBirth: app.dateOfBirth,
          addressLine1: app.addressLine1,
          addressLine2: app.addressLine2,
          city: app.city,
          district: app.district,
          ocrExtractedData: app.ocrExtractedData,
        },
      },
      bank,
      overrides,
    };
  }

  // ────────────────────────────────────────────────────────────────
  // PDF rendering
  // ────────────────────────────────────────────────────────────────

  private async render(
    v: CsdFieldValues & { date: string; applicationId: string },
  ): Promise<Buffer> {
    // Adapt the flat field values to the renderer's shape (checkbox booleans,
    // wrapped address lines).
    const wrapAddress = (s: string): string[] =>
      s ? s.split(',').map((p) => p.trim()).filter(Boolean) : [];
    const d = {
      ...v,
      genderMale: v.gender === 'M',
      genderFemale: v.gender === 'F',
      physicalLines: wrapAddress(v.physicalAddress),
      postalLines: wrapAddress(v.postalAddress),
    };

    const doc = await PDFDocument.create();
    const helv = await doc.embedFont(StandardFonts.Helvetica);
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);
    const W = 612, H = 792, M = 54; // US-Letter like the original
    const ink = rgb(0.1, 0.1, 0.12);
    const lineCol = rgb(0.45, 0.45, 0.5);
    const valueCol = rgb(0.05, 0.2, 0.45); // filled values in ink-blue

    let page = doc.addPage([W, H]);
    let y = H - 56;

    const text = (p: PDFPage, s: string, x: number, yy: number, size = 9, font: PDFFont = helv, color = ink) =>
      p.drawText(s, { x, y: yy, size, font, color });

    /** Label + dotted blank + value written over the blank. */
    const fieldRow = (
      p: PDFPage, label: string, value: string, x: number, yy: number,
      blankWidth: number, size = 9,
    ) => {
      text(p, label, x, yy, size);
      const labelW = helv.widthOfTextAtSize(label, size);
      const bx = x + labelW + 4;
      p.drawLine({
        start: { x: bx, y: yy - 2 },
        end: { x: bx + blankWidth, y: yy - 2 },
        thickness: 0.6, color: lineCol, dashArray: [1.5, 1.5],
      });
      if (value) {
        const fit = this.fitText(value, bold, size, blankWidth - 4);
        text(p, fit, bx + 3, yy + 0.5, size, bold, valueCol);
      }
      return bx + blankWidth;
    };

    const checkbox = (p: PDFPage, label: string, checked: boolean, x: number, yy: number) => {
      text(p, label, x, yy, 9);
      const lw = helv.widthOfTextAtSize(label, 9);
      p.drawRectangle({
        x: x + lw + 4, y: yy - 1.5, width: 9, height: 9,
        borderWidth: 0.8, borderColor: ink,
      });
      if (checked) text(p, 'X', x + lw + 6, yy, 9, bold, valueCol);
      return x + lw + 17;
    };

    // ── Header ────────────────────────────────────────────────────
    const title1 = 'Reserve Bank of Malawi';
    const title2 = 'SECURITIES ACCOUNT OPENING/UPDATE FORM (CSD)';
    const title3 = 'To be completed in BLOCK LETTERS';
    text(page, title1, (W - bold.widthOfTextAtSize(title1, 13)) / 2, y, 13, bold); y -= 18;
    text(page, title2, (W - bold.widthOfTextAtSize(title2, 11)) / 2, y, 11, bold); y -= 14;
    text(page, title3, (W - helv.widthOfTextAtSize(title3, 8.5)) / 2, y, 8.5); y -= 24;

    // ── Applicant particulars ─────────────────────────────────────
    text(page, 'APPLICANT PARTICULARS', M, y, 10.5, bold); y -= 15;
    text(page, 'For Individuals', M, y, 9.5, bold); y -= 15;

    let xEnd = fieldRow(page, 'Full Name', d.fullName, M, y, 300);
    let gx = checkbox(page, 'Gender:  Male', d.genderMale, xEnd + 12, y);
    checkbox(page, 'Female', d.genderFemale, gx + 6, y);
    y -= 18;

    xEnd = fieldRow(page, 'ID Type*:', d.idType, M, y, 110);
    xEnd = fieldRow(page, 'ID Number*:', d.idNumber, xEnd + 12, y, 130);
    fieldRow(page, 'Date of Birth*:', d.dateOfBirth, xEnd + 12, y, 100);
    y -= 18;
    fieldRow(page, 'Foreign/Local Investor*:', d.investorType, M, y, 180);
    y -= 22;

    // Joint applicant (left blank — single applicant flow)
    text(page, 'For Joint Applicant', M, y, 9.5, bold); y -= 15;
    xEnd = fieldRow(page, 'Full Name', '', M, y, 300);
    gx = checkbox(page, 'Gender:  Male', false, xEnd + 12, y);
    checkbox(page, 'Female', false, gx + 6, y);
    y -= 18;
    xEnd = fieldRow(page, 'ID Type*:', '', M, y, 110);
    xEnd = fieldRow(page, 'ID Number*:', '', xEnd + 12, y, 130);
    fieldRow(page, 'Date of Birth*:', '', xEnd + 12, y, 100);
    y -= 18;
    fieldRow(page, 'Foreign/Local Investor*:', '', M, y, 180);
    y -= 22;

    text(page, 'For Companies/Institutions:', M, y, 9.5, bold); y -= 15;
    xEnd = fieldRow(page, 'Company Name:', '', M, y, 200);
    fieldRow(page, 'Registration Number*:', '', xEnd + 12, y, 140);
    y -= 24;

    // ── Addresses (two columns) ───────────────────────────────────
    const colW = (W - 2 * M - 24) / 2;
    text(page, 'Physical Address*', M, y, 9.5, bold);
    text(page, 'Postal Address:', M + colW + 24, y, 9.5, bold);
    y -= 15;
    for (let i = 0; i < 4; i++) {
      const phys = d.physicalLines[i] ?? '';
      const post = d.postalLines[i] ?? '';
      page.drawLine({
        start: { x: M, y: y - 2 }, end: { x: M + colW, y: y - 2 },
        thickness: 0.6, color: lineCol, dashArray: [1.5, 1.5],
      });
      if (phys) text(page, this.fitText(phys, bold, 9, colW - 4), M + 2, y + 0.5, 9, bold, valueCol);
      page.drawLine({
        start: { x: M + colW + 24, y: y - 2 }, end: { x: W - M, y: y - 2 },
        thickness: 0.6, color: lineCol, dashArray: [1.5, 1.5],
      });
      if (post) text(page, this.fitText(post, bold, 9, colW - 4), M + colW + 26, y + 0.5, 9, bold, valueCol);
      y -= 16;
    }
    y -= 6;

    xEnd = fieldRow(page, 'Telephone*:', d.telephone, M, y, 120);
    xEnd = fieldRow(page, 'Cellphone*:', d.cellphone, xEnd + 12, y, 120);
    fieldRow(page, 'Fax:', '', xEnd + 12, y, 80);
    y -= 18;
    fieldRow(page, 'Email Address*:', d.email, M, y, 380);
    y -= 22;

    fieldRow(page, 'Authorised Signatories:', '', M, y, 180);
    fieldRow(page, ' ', '', M + 260, y, 180);
    y -= 18;

    text(
      page,
      'NB (*) Denotes required/mandatory fields. Completed forms must be accompanied by certified copy of ID',
      M, y, 7.5,
    ); y -= 10;
    text(page, 'Document & two (2) passport size photos', M, y, 7.5); y -= 20;

    // ── Dividend Disposal Instruction ─────────────────────────────
    text(page, 'Dividend Disposal Instruction', M, y, 10, bold); y -= 15;
    xEnd = fieldRow(page, 'Bank Name:', d.bankName, M, y, 150);
    xEnd = fieldRow(page, 'Bank Branch Code:', d.bankBranchCode, xEnd + 12, y, 80);
    fieldRow(page, 'Account Number:', d.accountNumber, xEnd + 12, y, 110);
    y -= 18;
    fieldRow(page, 'Account Name:', d.accountName, M, y, 300);

    // ── Page 2 ────────────────────────────────────────────────────
    page = doc.addPage([W, H]);
    y = H - 56;

    text(page, 'DECLARATION', M, y, 10.5, bold); y -= 16;
    const clauses = [
      'i.  I/We hereby request you to open and maintain a Securities Account in the Central Securities Depository (CSD) in my/our name(s).',
      'ii.  I/We hereby represent and warrant that I/We have good title to such securities that may be held in my/our Securities Account from time to time.',
      'iii. I/We affirm that the funds to be used for the purchase of Securities through my/our Securities Account will not be funds derived from any money laundering activity or funds generated from terrorist or any other illegal activity.',
      'iv. I/We hereby confirm that the undersigned Participant has full authority to intermediate and or conduct business with the Depository on our behalf in keeping with CSD Rules and Procedures that may be in force from time to time.',
      'v.  I/We agree to be bound by the terms and conditions articulated by the CSD Rules including any procedures and any other instructions.',
      'vi. I/We undertake to notify the under mentioned Participant of any change of particulars or information provided by me/us in this form.',
    ];
    for (const clause of clauses) {
      y = this.wrapText(page, clause, M, y, W - 2 * M, 8.5, helv, ink) - 4;
    }
    y -= 8;

    page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.8, color: ink });
    y -= 16;

    text(page, 'BROKER CONTROLLED ACCOUNT - STOCKBROKERS MANDATE', M, y, 10, bold); y -= 14;
    const mandate =
      'I/We hereby confirm that I/we appoint Stockbrokers Malawi Limited to manage my/our CSD Securities Account on our behalf, in accordance with the Terms and Conditions of the Depository in force from time to time. We understand that Stockbrokers Malawi Limited will be responsible for execution of our trade orders at the Malawi Stock Exchange ("MSE") and recording them on the CSD System while RBM or its agents will be responsible for managing both our cash & scrip settlements on the CSD System. We understand that CSD settlements once confirmed are irrevocable and irreversible and we indemnify Stockbrokers Malawi Limited against any losses arising as a result of these transactions. No responsibility will be accepted for any errors, omissions or delays in transmissions arising from circumstances beyond the control of Stockbrokers Malawi Limited.';
    y = this.wrapText(page, mandate, M, y, W - 2 * M, 8.5, helv, ink) - 18;

    xEnd = fieldRow(page, 'Primary Applicant Signature:', '', M, y, 200);
    fieldRow(page, 'Date:', d.date, xEnd + 20, y, 110);
    y -= 24;
    xEnd = fieldRow(page, 'Joint Applicant Signature:', '', M, y, 200);
    fieldRow(page, 'Date:', '', xEnd + 20, y, 110);
    y -= 30;

    // ── Participant / CSD boxes ───────────────────────────────────
    const boxH = 120;
    const boxW = (W - 2 * M - 16) / 2;
    page.drawRectangle({ x: M, y: y - boxH, width: boxW, height: boxH, borderWidth: 0.8, borderColor: ink });
    page.drawRectangle({ x: M + boxW + 16, y: y - boxH, width: boxW, height: boxH, borderWidth: 0.8, borderColor: ink });
    text(page, 'FOR PARTICIPANT USE ONLY', M + 8, y - 14, 9, bold);
    text(page, 'FOR CSD USE ONLY', M + boxW + 24, y - 14, 9, bold);
    let by = y - 30;
    this.wrapText(
      page,
      'Declaration: We, the undersigned undertake that we have checked the accuracy of the Documents submitted with this application.',
      M + 8, by, boxW - 16, 7.5, helv, ink,
    );
    text(page, 'Verified By: ______________________', M + 8, y - boxH + 34, 8.5);
    text(page, 'Signature:  ______________________', M + 8, y - boxH + 16, 8.5);
    text(page, 'Approved  [  ]     Declined  [  ]', M + boxW + 24, by, 8.5);
    text(page, 'Approved By: ____________________', M + boxW + 24, y - boxH + 52, 8.5);
    text(page, 'Signature: ______________________', M + boxW + 24, y - boxH + 34, 8.5);
    text(page, 'Securities Account No: ___________', M + boxW + 24, y - boxH + 16, 8.5);

    // Footer provenance line
    text(
      page,
      `Generated by Pine KYC · Application ${d.applicationId} · ${d.date}`,
      M, 30, 7, helv, rgb(0.5, 0.5, 0.55),
    );

    const bytes = await doc.save();
    return Buffer.from(bytes);
  }

  // ── Text helpers ─────────────────────────────────────────────────

  private fitText(s: string, font: PDFFont, size: number, maxWidth: number): string {
    if (font.widthOfTextAtSize(s, size) <= maxWidth) return s;
    let out = s;
    while (out.length > 1 && font.widthOfTextAtSize(out + '…', size) > maxWidth) {
      out = out.slice(0, -1);
    }
    return out + '…';
  }

  /** Draw word-wrapped text; returns the y coordinate after the last line. */
  private wrapText(
    page: PDFPage, s: string, x: number, y: number, maxWidth: number,
    size: number, font: PDFFont, color: ReturnType<typeof rgb>,
  ): number {
    const words = s.split(/\s+/);
    let line = '';
    let yy = y;
    for (const word of words) {
      const attempt = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(attempt, size) > maxWidth && line) {
        page.drawText(line, { x, y: yy, size, font, color });
        yy -= size + 2.5;
        line = word;
      } else {
        line = attempt;
      }
    }
    if (line) {
      page.drawText(line, { x, y: yy, size, font, color });
      yy -= size + 2.5;
    }
    return yy;
  }

  private formatDate(date: Date): string {
    const d = String(date.getUTCDate()).padStart(2, '0');
    const m = String(date.getUTCMonth() + 1).padStart(2, '0');
    return `${d}/${m}/${date.getUTCFullYear()}`;
  }
}
