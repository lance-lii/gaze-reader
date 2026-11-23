// Types for scripts/release-notes.mjs (so the vitest suite can import it under strict TypeScript).

export declare const MAX_RELEASE_BODY: number;
export declare function changelogSection(markdown: string, version: string): { note: string; body: string } | null;
export declare function releaseProblem(markdown: string, version: string): string | null;
export declare function absolutizeLinks(markdown: string, repo: string, tag: string): string;
export declare function releaseNotes(parts: {
  changelog: string;
  version: string;
  repo: string;
  site: string;
  zip: { name: string; sha256: string } | null;
}): string;
