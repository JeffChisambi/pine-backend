/**
 * Narrow, generic contract every concrete repository implements on top
 * of (e.g. `interface UserRepository extends BaseRepository<User, string>`,
 * defined in `modules/users/interfaces/`). Application services depend
 * on these interfaces, never on `PrismaService` directly — that keeps
 * the domain/application layers persistence-ignorant and trivially
 * mockable in unit tests, per Clean Architecture's dependency rule.
 *
 * Prisma-backed implementations live in each module's `repositories/`
 * folder starting Phase 2 (e.g. `PrismaUserRepository`).
 */
export interface BaseRepository<TEntity, TId> {
  findById(id: TId): Promise<TEntity | null>;
  save(entity: TEntity): Promise<void>;
  delete(id: TId): Promise<void>;
}

/**
 * Marker for repository methods that must run inside an existing
 * database transaction (passed down from the application service via
 * `PrismaService.$transaction`) rather than opening their own — used
 * throughout Wallet/Trading/Dividend repositories where multiple writes
 * (e.g. debit wallet + insert ledger entry + update order status) must
 * commit or roll back atomically together.
 */
export type TransactionalContext = unknown;
