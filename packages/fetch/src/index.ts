/**
 * @geo/fetch — public barrel export
 *
 * Wave 0: error model + IP classifier.
 * Wave 1: createSafeFetcher — hardened SSRF-safe Fetcher implementation.
 */

export { FetchErrorCode, buildErrorResult } from "./errors.js";
export type { FetchErrorCode as FetchErrorCodeType } from "./errors.js";
export { isBlockedIP } from "./ip-validator.js";
export { createSafeFetcher } from "./safe-fetcher.js";
export type { SafeFetcherOptions } from "./safe-fetcher.js";
