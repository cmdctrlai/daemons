/**
 * Lazy dynamic-import wrapper for `@mariozechner/pi-coding-agent`.
 *
 * Pi's package ships ESM-only (`"exports": { ".": { "import": "./dist/index.js" } }`);
 * this daemon compiles to CommonJS. CJS can load ESM via dynamic `import()`,
 * so we cache the module promise and resolve lazily at the first call site.
 * All value exports we need (SessionManager, VERSION, CURRENT_SESSION_VERSION)
 * go through `piSdk()`; types are imported via `import type` and erased at
 * compile time, so they don't need this indirection.
 */

export type PiSdk = typeof import('@mariozechner/pi-coding-agent');

let cache: Promise<PiSdk> | null = null;

export function piSdk(): Promise<PiSdk> {
  if (!cache) {
    // `Function('return import("…")')` avoids TS/tsc lowering the dynamic
    // import to a require() call when module=commonjs. Plain `import()` is
    // compiled to require() under CJS and then explodes on ESM-only packages.
    cache = (new Function('s', 'return import(s)') as (s: string) => Promise<PiSdk>)(
      '@mariozechner/pi-coding-agent',
    );
  }
  return cache;
}
