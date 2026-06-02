/**
 * @geo/fetch — public barrel export
 *
 * Wave 0 exports: error model + IP classifier.
 * Wave 1 will add createSafeFetcher (the network-capable Fetcher implementation).
 */

export { FetchErrorCode, buildErrorResult } from "./errors.js";
export type { FetchErrorCode as FetchErrorCodeType } from "./errors.js";
export { isBlockedIP } from "./ip-validator.js";
