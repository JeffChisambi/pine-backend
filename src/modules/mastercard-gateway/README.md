# mastercard-gateway module

Implements the **Mastercard Gateway REST API** (Direct Payment model) for Pine.

Integration guide: https://test-nbm.mtf.gateway.mastercard.com/api/documentation/integrationGuidelines/index.html

---

## Integration model: Direct Payment

Pine uses the **Direct Payment** integration model. The mobile app collects card
details from the user and sends them to this server over TLS. The server then
calls the Mastercard Gateway REST API directly — card data never leaves the
server unencrypted.

> **PCI-DSS scope:** Direct Payment means the server handles raw card data (PAN,
> CVV), which increases PCI scope. When the mobile SDK is available, consider
> migrating to the **Hosted Session** model (card data is tokenised client-side
> before reaching this server).

---

## Supported operations

| Operation   | Description                                          | Mastercard `apiOperation` |
|-------------|------------------------------------------------------|---------------------------|
| PAY         | Authorize + capture in one step (most common)        | `PAY`                     |
| AUTHORIZE   | Reserve funds without settling                       | `AUTHORIZE`               |
| CAPTURE     | Settle a previously authorized amount                | `CAPTURE`                 |
| REFUND      | Full or partial refund of a captured transaction     | `REFUND`                  |
| VOID        | Cancel an un-settled transaction                     | `VOID`                    |
| VERIFY CARD | Validate card without charging                       | `VERIFY`                  |
| RETRIEVE    | Poll current transaction status                      | GET (no apiOperation)     |
| HEALTH      | Check gateway is reachable and operating             | GET `/information`        |

---

## API structure

```
Base URL  : {MCGS_BASE_URL}/api/rest/version/{MCGS_API_VERSION}/merchant/{merchantId}
Auth      : HTTP Basic — username: merchant.{merchantId}, password: {MCGS_API_PASSWORD}

PAY/AUTHORIZE/CAPTURE/REFUND/VOID/VERIFY:
  PUT .../order/{orderId}/transaction/{transactionId}
  Body: { apiOperation, order, sourceOfFunds, ... }

RETRIEVE TRANSACTION:
  GET .../order/{orderId}/transaction/{transactionId}

GATEWAY HEALTH:
  GET {MCGS_BASE_URL}/api/rest/version/{MCGS_API_VERSION}/information
```

---

## ID conventions

Pine maps its own `txRef` to the gateway's `orderId` (1:1). Each operation on
an order gets a deterministic transaction ID:

| Operation | Transaction ID pattern      |
|-----------|-----------------------------|
| PAY       | `{txRef}-pay-1`             |
| AUTHORIZE | `{txRef}-auth-1`            |
| CAPTURE   | `{txRef}-cap-1`             |
| REFUND    | `{txRef}-ref-{timestamp}`   |
| VOID      | `{txRef}-void-1`            |
| VERIFY    | `{txRef}-ver-1`             |

> Note: The gateway enforces a **40-character limit** on both `orderId` and
> `transactionId`. Pine's txRef (`PINE-{uuid}`) is 41 chars — `MastercardGatewayService`
> truncates to 40 at the right-hand side in `sanitizeId()`.

---

## Environment variables

| Variable           | Required | Default                                                    | Description                                   |
|--------------------|----------|------------------------------------------------------------|-----------------------------------------------|
| `MCGS_BASE_URL`    | No       | `https://test-nbm.mtf.gateway.mastercard.com`             | Gateway host (switch to prod URL for live)    |
| `MCGS_MERCHANT_ID` | **Yes**  | —                                                          | Merchant ID issued by your payment provider   |
| `MCGS_API_PASSWORD`| **Yes**  | —                                                          | API password for HTTP Basic auth              |
| `MCGS_API_VERSION` | No       | `100`                                                      | REST API version (check docs for latest)      |
| `MCGS_ENVIRONMENT` | No       | `test`                                                     | `test` or `production`                        |

---

## Webhook endpoint

`POST /v1/payments/mcgs/webhook`

Configure this URL in the Mastercard Gateway merchant profile under
**Admin → Notifications**. The gateway POSTs a JSON payload here whenever a
transaction status changes.

The endpoint is `@Public()` (no JWT required) because it is called server-to-server
by the gateway. For production, add IP allowlisting to restrict it to Mastercard's
known IP ranges.

---

## Layout

```
mastercard-gateway/
  controllers/
    mastercard-gateway-webhook.controller.ts  — receives gateway notifications
  dto/
    mastercard-request.dto.ts                 — NestJS DTOs (charge, capture, void, webhook)
  exceptions/
    mastercard-gateway.exception.ts           — typed exceptions with HTTP mapping
  interfaces/
    mastercard-gateway.interface.ts           — raw API types + IMastercardGateway interface
  services/
    mastercard-gateway.service.ts             — core HTTP client + all operations
  mastercard-gateway.module.ts
  README.md (this file)
```

---

## Roadmap

- [ ] **3-D Secure (3DS2)** — add `3DSecure` parameters to PAY/AUTHORIZE for issuer
      authentication. Requires the mobile app to handle the ACS challenge redirect.
- [ ] **Card tokenisation** — store the gateway token returned after the first PAY so
      subsequent charges don't require the full PAN (requires gateway token storage).
- [ ] **IP allowlisting guard** — restrict the webhook endpoint to Mastercard IP ranges.
- [ ] **Idempotent webhook processing** — Redis lock + database upsert on notification receipt.
- [ ] **Webhook domain events** — emit `PaymentStatusChangedEvent` for downstream modules.
- [ ] **Hosted Session migration** — migrate to Hosted Session to reduce PCI scope once
      the mobile SDK is available.
