/**
 * The Agent SDK ships ESM only, which jest's CJS runtime cannot load. Suites
 * that exercise the adapter without driving an agent map the package here;
 * agent-session.test.ts supplies its own factory mock instead.
 */
export function query(): never {
  throw new Error('the Agent SDK is stubbed in tests; mock query() explicitly to drive a session');
}
