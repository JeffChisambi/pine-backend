import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../../infrastructure/database/prisma.service';
import { CardEncryptionService } from './card-encryption.service';

/** Fields safe to return to the client (never includes the encrypted PAN). */
const SAFE_SELECT = {
  id: true,
  last4: true,
  cardBrand: true,
  cardholderName: true,
  expiryMonth: true,
  expiryYear: true,
  isDefault: true,
  createdAt: true,
} as const;

/**
 * SavedCardService — CRUD for a user's encrypted saved cards.
 *
 * Limits: max 5 cards per user. First card becomes default automatically.
 * Duplicate detection: same last4 + expiry = already saved, returns existing.
 */
@Injectable()
export class SavedCardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: CardEncryptionService,
  ) {}

  /** List all saved cards for a user (safe fields only). */
  async listCards(userId: string) {
    return this.prisma.savedCard.findMany({
      where: { userId },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
      select: SAFE_SELECT,
    });
  }

  /** Save a new card. Returns the existing card if a duplicate is detected. */
  async saveCard(
    userId: string,
    data: {
      cardNumber: string;
      cardholderName: string;
      expiryMonth: string;
      expiryYear: string;
    },
  ) {
    // Never store an invalid PAN: digits-only, 13–19 long, Luhn-valid.
    const pan = data.cardNumber.replace(/\s/g, '');
    if (!/^\d{13,19}$/.test(pan) || !this.luhnValid(pan)) {
      throw new BadRequestException('Card number is not valid.');
    }
    data = { ...data, cardNumber: pan };

    // Max 5 cards per user
    const count = await this.prisma.savedCard.count({ where: { userId } });
    if (count >= 5) {
      throw new BadRequestException(
        'Maximum 5 saved cards allowed. Delete one first.',
      );
    }

    // Check for duplicate (same last4 + expiry)
    const last4 = data.cardNumber.slice(-4);
    const expiryYear =
      data.expiryYear.length === 4
        ? data.expiryYear.slice(-2)
        : data.expiryYear;

    const existing = await this.prisma.savedCard.findFirst({
      where: { userId, last4, expiryMonth: data.expiryMonth, expiryYear },
    });
    if (existing) {
      return {
        id: existing.id,
        last4: existing.last4,
        cardBrand: existing.cardBrand,
        cardholderName: existing.cardholderName,
        expiryMonth: existing.expiryMonth,
        expiryYear: existing.expiryYear,
        isDefault: existing.isDefault,
        createdAt: existing.createdAt,
      };
    }

    const cardBrand = this.detectBrand(data.cardNumber);
    // PAN encrypted with AES-256-GCM, AAD-bound to the owning user.
    const cardNumberEncrypted = this.encryption.encrypt(data.cardNumber, userId);
    const isDefault = count === 0; // First card becomes default

    return this.prisma.savedCard.create({
      data: {
        userId,
        last4,
        cardBrand,
        cardholderName: data.cardholderName,
        expiryMonth: data.expiryMonth,
        expiryYear,
        cardNumberEncrypted,
        isDefault,
      },
      select: SAFE_SELECT,
    });
  }

  // ── Card-on-file tokens (PCI scope reduction) ─────────────────────────────
  //
  // A tokenised card stores NO card number. The gateway holds the card behind
  // an opaque token that is only chargeable through the merchant that created
  // it — hence tokenBrokerId. Cards saved under a different broker are never
  // offered, because charging them would fail at the gateway.

  /**
   * Persist a card-on-file token produced from a payment session.
   * Never receives, and never stores, a card number.
   */
  async saveTokenizedCard(
    userId: string,
    brokerId: string,
    data: {
      token: string;
      last4: string;
      cardBrand: string;
      cardholderName: string;
      expiryMonth: string;
      expiryYear: string;
    },
  ) {
    const count = await this.prisma.savedCard.count({ where: { userId } });
    if (count >= 5) {
      throw new BadRequestException(
        'Maximum 5 saved cards allowed. Delete one first.',
      );
    }

    const expiryYear =
      data.expiryYear.length === 4 ? data.expiryYear.slice(-2) : data.expiryYear;
    const expiryMonth = data.expiryMonth.padStart(2, '0');

    // Same card, same broker → refresh the token rather than duplicating.
    const existing = await this.prisma.savedCard.findFirst({
      where: { userId, last4: data.last4, expiryMonth, expiryYear, tokenBrokerId: brokerId },
    });
    if (existing) {
      return this.prisma.savedCard.update({
        where: { id: existing.id },
        data: { gatewayToken: data.token, cardholderName: data.cardholderName },
        select: SAFE_SELECT,
      });
    }

    return this.prisma.savedCard.create({
      data: {
        userId,
        last4: data.last4,
        cardBrand: data.cardBrand,
        cardholderName: data.cardholderName,
        expiryMonth,
        expiryYear,
        gatewayToken: data.token,
        tokenBrokerId: brokerId,
        cardNumberEncrypted: null,
        isDefault: count === 0,
      },
      select: SAFE_SELECT,
    });
  }

  /**
   * Resolve a saved card to a chargeable gateway token.
   *
   * Throws when the card is not tokenised (legacy PAN-era row) or belongs to
   * a different broker's merchant — both are unchargeable, and failing here
   * is far better than a confusing gateway decline.
   */
  async getChargeableToken(
    userId: string,
    cardId: string,
    brokerId: string,
  ): Promise<{ token: string; last4: string; cardBrand: string }> {
    const card = await this.prisma.savedCard.findFirst({
      where: { id: cardId, userId },
    });
    if (!card) throw new NotFoundException('Saved card not found.');

    if (!card.gatewayToken) {
      throw new BadRequestException(
        'This saved card needs to be re-added before it can be used. ' +
        'Please enter the card once more and tick "save card".',
      );
    }
    if (card.tokenBrokerId && card.tokenBrokerId !== brokerId) {
      throw new BadRequestException(
        'This card was saved with a different broker and can no longer be charged. ' +
        'Please add it again.',
      );
    }

    return { token: card.gatewayToken, last4: card.last4, cardBrand: card.cardBrand };
  }

  /**
   * Cards the investor can actually pay with right now: tokenised under the
   * broker they currently belong to. Legacy PAN rows are reported as
   * unusable so the app can prompt a one-time re-add instead of failing at
   * the gateway.
   */
  async listChargeableCards(userId: string, brokerId: string | null) {
    const cards = await this.prisma.savedCard.findMany({
      where: { userId },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
    });
    return cards.map((c) => ({
      id: c.id,
      last4: c.last4,
      cardBrand: c.cardBrand,
      cardholderName: c.cardholderName,
      expiryMonth: c.expiryMonth,
      expiryYear: c.expiryYear,
      isDefault: c.isDefault,
      createdAt: c.createdAt,
      /** False for legacy PAN rows or a token issued by another broker. */
      chargeable: Boolean(c.gatewayToken) && (!c.tokenBrokerId || c.tokenBrokerId === brokerId),
    }));
  }

  /** Delete a saved card. Promotes the next card if the deleted one was default. */
  async deleteCard(userId: string, cardId: string) {
    const card = await this.prisma.savedCard.findFirst({
      where: { id: cardId, userId },
    });
    if (!card) throw new NotFoundException('Card not found');

    await this.prisma.savedCard.delete({ where: { id: cardId } });

    // If deleted card was default, promote the next one
    if (card.isDefault) {
      const next = await this.prisma.savedCard.findFirst({
        where: { userId },
        orderBy: { createdAt: 'asc' },
      });
      if (next) {
        await this.prisma.savedCard.update({
          where: { id: next.id },
          data: { isDefault: true },
        });
      }
    }
  }

  /** Set a card as the default (unsets all others first). */
  async setDefault(userId: string, cardId: string) {
    const card = await this.prisma.savedCard.findFirst({
      where: { id: cardId, userId },
    });
    if (!card) throw new NotFoundException('Card not found');

    await this.prisma.$transaction([
      this.prisma.savedCard.updateMany({
        where: { userId },
        data: { isDefault: false },
      }),
      this.prisma.savedCard.update({
        where: { id: cardId },
        data: { isDefault: true },
      }),
    ]);
  }

  /** Retrieve the full decrypted card details (for internal use during payment). */
  async getDecryptedCard(userId: string, cardId: string) {
    const card = await this.prisma.savedCard.findFirst({
      where: { id: cardId, userId },
    });
    if (!card) throw new NotFoundException('Saved card not found');

    // LEGACY PATH ONLY. Tokenised cards hold no PAN — callers must use
    // getChargeableToken() instead. Kept so pre-tokenisation rows and the
    // sandbox/mock gateway keep working until those rows age out.
    if (!card.cardNumberEncrypted) {
      throw new BadRequestException(
        'This card is stored as a secure token and has no card number on file.',
      );
    }
    const cardNumber = this.encryption.decrypt(card.cardNumberEncrypted, userId);
    return {
      cardNumber,
      cardholderName: card.cardholderName,
      expiryMonth: card.expiryMonth,
      expiryYear: card.expiryYear,
      last4: card.last4,
      cardBrand: card.cardBrand,
    };
  }

  /** Detect card brand from the PAN prefix. */
  private detectBrand(num: string): string {
    if (/^4/.test(num)) return 'VISA';
    if (/^5[1-5]/.test(num) || /^2[2-7]/.test(num)) return 'MASTERCARD';
    return 'UNKNOWN';
  }

  /** Luhn checksum — rejects mistyped/garbage PANs before they're stored. */
  private luhnValid(pan: string): boolean {
    let sum = 0;
    let double = false;
    for (let i = pan.length - 1; i >= 0; i--) {
      let d = pan.charCodeAt(i) - 48;
      if (double) {
        d *= 2;
        if (d > 9) d -= 9;
      }
      sum += d;
      double = !double;
    }
    return sum % 10 === 0;
  }
}
