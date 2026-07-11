import { Module } from '@nestjs/common';

/**
 * AnalyticsModule — implemented in Phase 6.
 *
 * DAU, trade/deposit/withdrawal volume, revenue, market & growth metrics.
 *
 * This module is intentionally registered empty in Phase 1. Its
 * sub-folders (controllers/, services/, repositories/, domain/, dto/,
 * events/, interfaces/, policies/, tests/) are scaffolded now so the
 * project's module boundaries and Clean-Architecture layering are fixed
 * from the start; real providers/controllers are added — and this file
 * updated to register them — in Phase 6. See README.md in this folder.
 */
@Module({})
export class AnalyticsModule {}
