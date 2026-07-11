# admin module

**Status:** scaffolded in Phase 1, implemented in **Phase 6**.

Staff-facing user/KYC/market/order/wallet management, fraud monitoring, reports.

## Layout

- `controllers/` — HTTP entrypoints only. No business logic (thin controllers).
- `services/` — application services orchestrating use cases.
- `repositories/` — Prisma-backed persistence, implementing interfaces from `interfaces/`.
- `domain/` — entities, value objects, aggregate roots, domain services.
- `dto/` — request/response DTOs (class-validator decorated).
- `events/` — domain events published by this module.
- `interfaces/` — repository & port interfaces the application layer depends on.
- `policies/` — authorization/business-rule policies (e.g. CASL-style or hand-rolled).
- `tests/` — unit/integration tests colocated with the module.
