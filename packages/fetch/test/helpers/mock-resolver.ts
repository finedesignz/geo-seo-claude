/**
 * Injectable fake DNS resolver for DNS-rebinding and SSRF integration tests.
 *
 * Designed for Wave 1+ tests where the real DNS lookup is injected as a
 * dependency so the test controls what IP the fetcher "resolves" to.
 *
 * Usage (rebinding scenario):
 *   const resolve = createMockResolver([
 *     ["8.8.8.8"],         // first call → public IP (passes SSRF check)
 *     ["169.254.169.254"], // second call → metadata IP (rebinding attack)
 *   ]);
 *   // Pass `resolve` to createSafeFetcher({ resolver: resolve })
 *
 * Each call to the resolver pops the next entry from the sequence.
 * After the sequence is exhausted, throws to make test failures obvious.
 */

export type MockResolver = (hostname: string) => Promise<string[]>;

/**
 * Creates a fake resolver that returns queued IP arrays on successive calls.
 *
 * @param sequence - Ordered list of address arrays to return per call.
 *   Each inner array is what one DNS lookup "returns" (multiple A records).
 */
export function createMockResolver(sequence: string[][]): MockResolver {
  const queue = [...sequence];

  return async (_hostname: string): Promise<string[]> => {
    const next = queue.shift();
    if (next === undefined) {
      throw new Error(
        `MockResolver exhausted — no more entries in sequence. ` +
          `Add more entries to the sequence array if you need additional calls.`,
      );
    }
    return next;
  };
}

/**
 * Creates a resolver that always returns the same fixed set of addresses.
 * Useful for simple tests that don't need to simulate rebinding.
 */
export function createStaticResolver(addresses: string[]): MockResolver {
  return async (_hostname: string): Promise<string[]> => addresses;
}
