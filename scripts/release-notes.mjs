// Writes the text of a GitHub release from CHANGELOG.md.
//
//   CHANGELOG.md, section "## <version> (<date>)"  →  release notes (stdout, or --out <file>)
//
// The release workflow (.github/workflows/release.yml) runs this for the version in
// package.json, so a version that has no dated section in the changelog cannot be released.
// Links that are relative in the repository (README.md#lighting) would lead nowhere on the
// releases page, so they are pointed at the tagged files.
//
// Usage: node scripts/release-notes.mjs [--out <file>] [--zip <file>] [--repo <owner/name>]
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** GitHub refuses a release body longer than this many characters. */
export const MAX_RELEASE_BODY = 125_000;

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The changelog's section for one version: its heading's note ("2026-11-23", "unreleased, …")
 * and its text without the heading. Null when the changelog has no such section.
 */
export function changelogSection(markdown, version) {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const heading = new RegExp(`^## +\\[?${escapeRegExp(version)}\\]?(?: +\\((.*)\\))? *$`);
  const start = lines.findIndex((l) => heading.test(l));
  if (start < 0) return null;
  let end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  if (end < 0) end = lines.length;
  return {
    note: heading.exec(lines[start])[1] ?? '',
    body: lines.slice(start + 1, end).join('\n').trim(),
  };
}

/** Why this version can't be released from this changelog, or null when it can. */
export function releaseProblem(markdown, version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) return `"${version}" is not a release version (expected 1.2.3).`;
  const section = changelogSection(markdown, version);
  if (!section) return `CHANGELOG.md has no "## ${version} (date)" section.`;
  if (/unreleased/i.test(section.note)) return `CHANGELOG.md still marks ${version} as unreleased.`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(section.note)) return `The ${version} heading in CHANGELOG.md needs its date: "## ${version} (YYYY-MM-DD)".`;
  if (!section.body) return `The ${version} section of CHANGELOG.md is empty.`;
  return null;
}

/** Points links to files of the repository at those files as they are in the tag. */
export function absolutizeLinks(markdown, repo, tag) {
  return markdown.replace(/\]\(([^)\s]+)\)/g, (whole, target) => {
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(target)) return whole;
    const path = target.replace(/^\.?\//, '');
    if (path.startsWith('..')) return whole;
    return `](https://github.com/${repo}/blob/${tag}/${path})`;
  });
}

/** The release's text: where to get this version, then what changed. */
export function releaseNotes({ changelog, version, repo, site, zip }) {
  const problem = releaseProblem(changelog, version);
  if (problem) throw new Error(problem);
  const tag = `v${version}`;
  const blob = `https://github.com/${repo}/blob/${tag}`;
  const get = [
    '## Get it',
    '',
    `- **Web app:** <${site}>. Nothing to install.`,
    zip
      ? `- **Chrome and Edge extension:** download \`${zip.name}\` below, unzip it and load the folder as an unpacked extension. [Step by step](${blob}/docs/INSTALL-EXTENSION.md).`
      : `- **Chrome and Edge extension:** [build and install it](${blob}/docs/INSTALL-EXTENSION.md).`,
    ...(zip ? ['', `SHA-256 of \`${zip.name}\`: \`${zip.sha256}\``] : []),
    '',
    `## What changed in ${version}`,
    '',
    '',
  ].join('\n');
  const out = `${get}${absolutizeLinks(changelogSection(changelog, version).body, repo, tag)}\n`;
  if (out.length > MAX_RELEASE_BODY) {
    throw new Error(`The release notes are ${out.length} characters; GitHub allows ${MAX_RELEASE_BODY}. Shorten the ${version} section of CHANGELOG.md.`);
  }
  return out;
}

// ─────────────────────────────────── CLI ─────────────────────────────────────

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const arg = (name) => {
    const i = process.argv.indexOf(name);
    return i >= 0 ? process.argv[i + 1] : undefined;
  };
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    const zipPath = arg('--zip');
    const notes = releaseNotes({
      changelog: readFileSync(join(root, 'CHANGELOG.md'), 'utf8'),
      version: pkg.version,
      repo: arg('--repo') ?? process.env.GITHUB_REPOSITORY ?? 'lance-lii/gaze-reader',
      site: 'https://lance-lii.github.io/gaze-reader/',
      zip: zipPath
        ? { name: basename(zipPath), sha256: createHash('sha256').update(readFileSync(resolve(zipPath))).digest('hex') }
        : null,
    });
    const out = arg('--out');
    if (out) {
      writeFileSync(resolve(out), notes);
      console.log(`[release-notes] ${out}: ${pkg.version}, ${notes.length} characters`);
    } else {
      process.stdout.write(notes);
    }
  } catch (err) {
    console.error(`[release-notes] ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}
