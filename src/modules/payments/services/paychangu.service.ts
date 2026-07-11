import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../../../config/app-config.service';

/**
 * PayChangu API response types
 */
export interface PaychanguInitiateResponse {
  message: string;
  status: string;
  data: {
    event: string;
    checkout_url: string;
    data: {
      tx_ref: string;
      currency: string;
      amount: number;
      mode: string;
      status: string;
    };
  };
}

export interface PaychanguVerifyResponse {
  status: string;
  message: string;
  data: {
    event_type: string;
    tx_ref: string;
    mode: string;
    type: string;
    status: string; // 'success' | 'failed' | 'pending'
    number_of_attempts: number;
    reference: string;
    currency: string;
    amount: number;
    charges: number;
    customization: { title: string; description: string; logo: string | null };
    meta: Record<string, any> | null;
    authorization: {
      channel: string;
      card_number?: string;
      expiry?: string;
      brand?: string;
      provider?: string;
      mobile_number?: string;
      completed_at: string;
    };
    customer: {
      email: string;
      first_name: string;
      last_name: string;
    };
    created_at: string;
    updated_at: string;
  };
}

/**
 * PaychanguService — wraps the PayChangu REST API.
 *
 * Standard Checkout flow:
 *   1. Backend calls POST /payment → gets checkout_url
 *   2. User opens checkout_url in browser/webview → pays
 *   3. PayChangu redirects to callback_url with tx_ref
 *   4. Backend calls GET /verify-payment/{tx_ref} → confirms payment
 */
@Injectable()
export class PaychanguService {
  private readonly logger = new Logger(PaychanguService.name);
  private readonly baseUrl: string;
  private readonly secretKey: string;

  constructor(private readonly config: AppConfigService) {
    this.baseUrl = config.paychangu.baseUrl;
    this.secretKey = config.paychangu.secretKey;
  }

  /**
   * Initiate a PayChangu checkout session.
   *
   * Returns a checkout_url the user should be redirected to.
   */
  async initiatePayment(params: {
    amount: number;
    currency: 'MWK' | 'USD';
    txRef: string;
    firstName?: string;
    lastName?: string;
    email?: string;
    callbackUrl: string;
    returnUrl: string;
    meta?: Record<string, any>;
    customization?: { title: string; description: string };
  }): Promise<PaychanguInitiateResponse> {
    const url = `${this.baseUrl}/payment`;

    // PayChangu requires meta as an array of {key, value} objects
    const metaArray = params.meta
      ? Object.entries(params.meta)
          .filter(([, v]) => v !== undefined && v !== null)
          .map(([key, value]) => ({ key, value: String(value) }))
      : undefined;

    const body = {
      amount: String(params.amount),
      currency: params.currency,
      tx_ref: params.txRef,
      first_name: params.firstName,
      last_name: params.lastName,
      email: params.email,
      callback_url: params.callbackUrl,
      return_url: params.returnUrl,
      meta: metaArray,
      customization: params.customization,
    };

    this.logger.log(`Initiating PayChangu payment: txRef=${params.txRef}, amount=${params.amount} ${params.currency}`);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${this.secretKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      this.logger.error(`PayChangu initiate failed: ${response.status} — ${errorBody}`);
      throw new Error(`PayChangu payment initiation failed: ${errorBody}`);
    }

    const result: PaychanguInitiateResponse = await response.json();
    this.logger.log(`PayChangu checkout created: ${result.data?.checkout_url}`);
    return result;
  }

  /**
   * Verify a PayChangu transaction status.
   *
   * Call this after receiving a callback or webhook to confirm
   * the payment actually succeeded before crediting the user.
   */
  async verifyPayment(txRef: string): Promise<PaychanguVerifyResponse> {
    const url = `${this.baseUrl}/verify-payment/${txRef}`;

    this.logger.log(`Verifying PayChangu payment: txRef=${txRef}`);

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${this.secretKey}`,
      },
    });

    if (!response.ok) {
      const errorBody = await response.text();
      this.logger.error(`PayChangu verify failed: ${response.status} — ${errorBody}`);
      throw new Error(`PayChangu verification failed: ${errorBody}`);
    }

    const result: PaychanguVerifyResponse = await response.json();
    this.logger.log(`PayChangu verify result: txRef=${txRef}, status=${result.data?.status}`);
    return result;
  }
}
