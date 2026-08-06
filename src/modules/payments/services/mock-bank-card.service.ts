import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  BankCardChargeParams,
  BankCardChargeResult,
  BankCardVerifyResult,
} from '../interfaces/bank-card-gateway.interface';
import { MastercardGatewayException } from '../../mastercard-gateway/exceptions/mastercard-gateway.exception';

/**
 * MockBankCardGatewayService — a faithful stand-in for the Mastercard
 * Payment Gateway (MPGS) used by Test Transaction mode while live API
 * credentials are pending.
 *
 * It speaks the SAME vocabulary as the real gateway (result +
 * response.gatewayCode: APPROVED / DECLINED / INSUFFICIENT_FUNDS /
 * EXPIRED_CARD / TIMED_OUT …) and throws the same exception type, so the
 * orchestration layer, error mapping, receipts and mobile UI exercise the
 * exact code paths production will use. Enabling live payments is a
 * configuration change only — no business logic changes.
 *
 * Scenario selection (first match wins):
 *   1. Explicit `meta.testScenario` from the Test Transaction button.
 *   2. Magic test card numbers (mirrors gateway test-card conventions):
 *        …0002 → DECLINED           …0069 → EXPIRED_CARD
 *        …0051 → INSUFFICIENT_FUNDS …0119 → TIMED_OUT
 *   3. Anything else approves.
 *
 * PCI note: card details are received, used to derive brand/last4 only,
 * and NEVER logged or stored — identical discipline to the live service.
 */
export type MockScenario =
  | 'success'
  | 'declined'
  | 'insufficient_funds'
  | 'expired_card'
  | 'network_failure'
  | 'timeout'
  | 'duplicate';

const MAGIC_SUFFIX_SCENARIOS: Record<string, MockScenario> = {
  '0002': 'declined',
  '0051': 'insufficient_funds',
  '0069': 'expired_card',
  '0119': 'timeout',
};

@Injectable()
export class MockBankCardGatewayService {
  private readonly logger = new Logger(MockBankCardGatewayService.name);

  /** Completed charges, kept so verifyTransaction can answer status polls. */
  private readonly charges = new Map<
    string,
    { status: 'SUCCESS' | 'FAILED'; amount: number; currency: string; updatedAt: string; failureReason?: string }
  >();

  async chargeCard(params: BankCardChargeParams): Promise<BankCardChargeResult> {
    const scenario = this.resolveScenario(params);
    const last4 = params.cardNumber.slice(-4);
    const brand = this.detectBrand(params.cardNumber);

    // Simulated processing latency (network round-trip to the gateway).
    await this.delay(scenario === 'timeout' ? 2_500 : 900);

    this.logger.log(
      { txRef: params.txRef, scenario, amount: params.amount, last4, brand, testMode: true },
      'Mock gateway processing charge',
    );

    switch (scenario) {
      case 'declined':
        this.record(params, 'FAILED', 'Card declined by issuer');
        throw new MastercardGatewayException({
          gatewayResult: 'FAILURE',
          gatewayCode: 'DECLINED',
          errorExplanation: 'The card was declined by the issuing bank.',
        });

      case 'insufficient_funds':
        this.record(params, 'FAILED', 'Insufficient funds');
        throw new MastercardGatewayException({
          gatewayResult: 'FAILURE',
          gatewayCode: 'INSUFFICIENT_FUNDS',
          errorExplanation: 'The card has insufficient funds for this payment.',
        });

      case 'expired_card':
        this.record(params, 'FAILED', 'Card expired');
        throw new MastercardGatewayException({
          gatewayResult: 'FAILURE',
          gatewayCode: 'EXPIRED_CARD',
          errorExplanation: 'The card has expired.',
        });

      case 'timeout':
        this.record(params, 'FAILED', 'Gateway timeout');
        throw new MastercardGatewayException({
          gatewayResult: 'UNKNOWN',
          gatewayCode: 'TIMED_OUT',
          errorExplanation: 'The gateway did not respond in time. The charge was not completed.',
        });

      case 'network_failure': {
        this.record(params, 'FAILED', 'Network failure');
        const err = new Error('simulated network failure: connection reset by peer');
        (err as any).code = 'ECONNRESET';
        throw err;
      }

      case 'duplicate':
      case 'success': {
        this.record(params, 'SUCCESS');
        return {
          processorReference: `MOCK-${randomUUID()}`,
          txRef: params.txRef,
          status: 'SUCCESS' as BankCardChargeResult['status'],
          amount: params.amount,
          currency: params.currency,
          last4,
          cardBrand: brand,
          message:
            scenario === 'duplicate'
              ? 'Approved (TEST) — duplicate submission was detected and charged exactly once.'
              : 'Approved (TEST)',
          chargedAt: new Date().toISOString(),
        };
      }
    }
  }

  async verifyTransaction(txRef: string): Promise<BankCardVerifyResult> {
    const known = this.charges.get(txRef);
    return {
      processorReference: `MOCK-${txRef}`,
      txRef,
      status: (known?.status ?? 'FAILED') as BankCardVerifyResult['status'],
      amount: known?.amount ?? 0,
      currency: known?.currency ?? 'MWK',
      updatedAt: known?.updatedAt ?? new Date().toISOString(),
      failureReason: known?.failureReason,
    };
  }

  /* ── helpers ── */

  private resolveScenario(params: BankCardChargeParams): MockScenario {
    const explicit = params.meta?.testScenario as MockScenario | undefined;
    if (explicit) return explicit;
    return MAGIC_SUFFIX_SCENARIOS[params.cardNumber.slice(-4)] ?? 'success';
  }

  private detectBrand(cardNumber: string): string {
    if (/^4/.test(cardNumber)) return 'Visa';
    if (/^(5[1-5]|2(2[2-9]|[3-6]\d|7[01]))/.test(cardNumber)) return 'Mastercard';
    return 'Card';
  }

  private record(
    params: BankCardChargeParams,
    status: 'SUCCESS' | 'FAILED',
    failureReason?: string,
  ): void {
    this.charges.set(params.txRef, {
      status,
      amount: params.amount,
      currency: params.currency,
      updatedAt: new Date().toISOString(),
      failureReason,
    });
    // Bound the in-memory map (test mode only; DB remains the source of truth).
    if (this.charges.size > 500) {
      const first = this.charges.keys().next().value;
      if (first) this.charges.delete(first);
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}
