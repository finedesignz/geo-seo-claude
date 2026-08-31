// @geo/db — public surface area (plans 01 + 02)

// Client
export { getSql, _resetSqlForTests } from "./client.js";

// Migrations
export { runMigrations, listApplied } from "./migrate.js";
export type { MigrationDb } from "./migrate.js";

// Types (interface-first, D-10)
export type {
  AuditStatus,
  AuditJob,
  FindingsShape,
  InsertJobInput,
  PaginationInput,
} from "./types.js";

// DAL
export {
  createAuditDal,
  getDefaultDal,
  makePgExecutor,
  _resetDefaultDalForTests,
} from "./dal.js";
export type { AuditDal, SqlExecutor } from "./dal.js";
