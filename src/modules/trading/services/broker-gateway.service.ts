import { Injectable, Logger } from '@nestjs/common';
import { Decimal } from '@prisma/client/runtime/library';

/**
 * Broker Gateway — abstracts how orders leave Pine and reach the exchange.
 *
 * Today: SandboxAdapter (instant-fill for development).
 * Tomorrow: MSEBrokerAdapter that exposes pending orders to the broker dashboard.
 *
 * The broker dashboard will:
 * 1. Poll GET /v1/broker/orders/pending for submitted orders
 * 2. Accept orders → POST /v1/broker/orders/:id/accept
 * 3. Fill orders  → POST /v1/broker/orders/:id/fill
 * 4. Reject orders → POST /v1/broker/orders/:id/reject
 */

// ── Interface ──────────────────────────────────────────────────

export interface BrokerOrderSubmission {
  orderId: string;
  stockSymbol: string;
  side: 'BUY' | 'SELL';
  type: 'MARKET' | 'LIMIT';
  quantity: number;
  limitPrice?: number;
  estimatedPrice: number;
}

export interface BrokerFillResult {
  brokerRef: string;
  filledQuantity: number;
  fillPrice: number;
  status: 'FILLED' | 'PARTIALLY_FILLED' | 'REJECTED';
  rejectionReason?: string;
}

export interface IBrokerAdapter {
  readonly name: string;
  submitOrder(order: BrokerOrderSubmission): Promise<BrokerFillResult>;
  getOrderStatus(brokerRef: string): Promise<{ status: string }>;
}

// ── Sandbox Adapter (development) ──────────────────────────────

/**
 * Sandbox broker adapter for development and testing.
 * Instantly fills all orders at the estimated price.
 * No real broker interaction.
 */
@Injectable()
export class SandboxBrokerAdapter implements IBrokerAdapter {
  readonly name = 'sandbox';
  private readonly logger = new Logger(SandboxBrokerAdapter.name);
  private orderCounter = 0;

  async submitOrder(order: BrokerOrderSubmission): Promise<BrokerFillResult> {
    this.orderCounter++;
    const brokerRef = `SBX-${Date.now()}-${this.orderCounter}`;

    this.logger.log(
      { brokerRef, orderId: order.orderId, symbol: order.stockSymbol },
      'Sandbox: order instantly filled',
    );

    // Simulate instant fill at estimated price
    return {
      brokerRef,
      filledQuantity: order.quantity,
      fillPrice: order.estimatedPrice,
      status: 'FILLED',
    };
  }

  async getOrderStatus(brokerRef: string): Promise<{ status: string }> {
    return { status: 'FILLED' };
  }
}

// ── MSE Broker Adapter (production — broker dashboard) ─────────

/**
 * MSE Broker Adapter for production.
 *
 * Instead of calling an external API, this adapter stores orders in
 * "SUBMITTED" status in the database. The broker dashboard (a separate
 * web app you'll build) polls these orders and fills/rejects them
 * through the broker API endpoints.
 *
 * Flow:
 * 1. Pine app → user places order → order goes to SUBMITTED
 * 2. Broker dashboard → sees pending order → fills it
 * 3. Broker dashboard → POST /v1/broker/orders/:id/fill
 * 4. Pine backend → receives fill → completes the order lifecycle
 *
 * For now this adapter behaves like Sandbox (instant fill) until
 * the broker dashboard is built. When ready, change `submitOrder`
 * to return status: 'SUBMITTED' instead of 'FILLED', and the
 * broker dashboard will handle the rest.
 */
@Injectable()
export class MSEBrokerAdapter implements IBrokerAdapter {
  readonly name = 'mse';
  private readonly logger = new Logger(MSEBrokerAdapter.name);
  private orderCounter = 0;

  async submitOrder(order: BrokerOrderSubmission): Promise<BrokerFillResult> {
    this.orderCounter++;
    const brokerRef = `MSE-${Date.now()}-${this.orderCounter}`;

    this.logger.log(
      { brokerRef, orderId: order.orderId, symbol: order.stockSymbol },
      'MSE Broker: order submitted (auto-fill mode until broker dashboard is connected)',
    );

    // Auto-fill mode: instant fill at estimated price.
    // When the broker dashboard is ready, change this to:
    //   status: 'SUBMITTED' (and remove filledQuantity/fillPrice)
    // Then the broker dashboard will call /v1/broker/orders/:id/fill
    return {
      brokerRef,
      filledQuantity: order.quantity,
      fillPrice: order.estimatedPrice,
      status: 'FILLED',
    };
  }

  async getOrderStatus(brokerRef: string): Promise<{ status: string }> {
    return { status: 'FILLED' };
  }
}

// ── Gateway (selects the active adapter) ───────────────────────

export const BROKER_ADAPTER = 'BROKER_ADAPTER';

@Injectable()
export class BrokerGateway {
  private readonly logger = new Logger(BrokerGateway.name);

  constructor(
    private readonly adapter: IBrokerAdapter,
  ) {}

  get adapterName(): string {
    return this.adapter.name;
  }

  async submitOrder(order: BrokerOrderSubmission): Promise<BrokerFillResult> {
    this.logger.log(
      { adapter: this.adapter.name, orderId: order.orderId },
      'Submitting order to broker',
    );
    return this.adapter.submitOrder(order);
  }

  async getOrderStatus(brokerRef: string): Promise<{ status: string }> {
    return this.adapter.getOrderStatus(brokerRef);
  }
}
