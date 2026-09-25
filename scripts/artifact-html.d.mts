// Types for scripts/artifact-html.mjs (so the vitest suite can import it under strict TypeScript).

export declare const ALLOWED_SCRIPT_ORIGINS: readonly string[];
export declare const ALLOWED_STYLE_ORIGINS: readonly string[];
export declare const MAX_PAGE_BYTES: number;
export declare const TITLE_WITHIN_BYTES: number;

export declare const CONTROL_CHARS: RegExp;
export declare function escapeControlChars(js: string): string;
export declare function escapeInlineScript(js: string): string;
export declare function assertInlineableCss(css: string): string;
export declare function buildArtifactHtml(parts: { title: string; css: string; js: string; markup: string }): string;
export declare function checkArtifactHtml(html: string, opts?: { allowedFetchUrls?: readonly string[] }): string[];
export declare function formatBytes(n: number): string;
