/**
 * Which build this is, replaced at compile time by Vite's `define`:
 * 'web' in vite.config.ts, 'artifact' in scripts/build-artifact.mjs. Tests and
 * the extension build don't define it; read it only through src/core/target.ts.
 */
declare const __GR_TARGET__: 'web' | 'artifact' | undefined;
