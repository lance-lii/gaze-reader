import { describe, expect, it } from 'vitest';
import { absolutizeLinks, changelogSection, MAX_RELEASE_BODY, releaseNotes, releaseProblem } from '../scripts/release-notes.mjs';

const REPO = 'lance-lii/gaze-reader';
const SITE = 'https://lance-lii.github.io/gaze-reader/';

const CHANGELOG = `# Changelog

## Unreleased

Nothing yet.

## 1.2.0 (2026-11-23)

Steadier tracking. See [Lighting](README.md#lighting) and [the paper](https://example.org/a).

### Web app

- One.

## 1.10.0 (unreleased, 2026-12-01)

Later.

## 1.1.0 (2026-09-25)

Lighting.
`;

describe('changelogSection', () => {
  it('takes one version from its heading to the next version', () => {
    const section = changelogSection(CHANGELOG, '1.2.0');
    expect(section?.note).toBe('2026-11-23');
    expect(section?.body.startsWith('Steadier tracking.')).toBe(true);
    expect(section?.body.endsWith('- One.')).toBe(true);
    expect(section?.body).toContain('### Web app');
  });

  it('does not take 1.10.0 for 1.1.0, or the other way round', () => {
    expect(changelogSection(CHANGELOG, '1.1.0')?.body).toBe('Lighting.');
    expect(changelogSection(CHANGELOG, '1.10.0')?.body).toBe('Later.');
    expect(changelogSection(CHANGELOG, '1.1')).toBeNull();
  });

  it('reads the last section to the end of the file, and Windows line endings', () => {
    expect(changelogSection(CHANGELOG.replace(/\n/g, '\r\n'), '1.1.0')?.body).toBe('Lighting.');
  });

  it('says so when the version is not there', () => {
    expect(changelogSection(CHANGELOG, '2.0.0')).toBeNull();
  });
});

describe('releaseProblem', () => {
  it('lets a dated section through', () => {
    expect(releaseProblem(CHANGELOG, '1.2.0')).toBeNull();
  });

  it('stops a version the changelog does not describe, or still calls unreleased', () => {
    expect(releaseProblem(CHANGELOG, '2.0.0')).toMatch(/no "## 2\.0\.0/);
    expect(releaseProblem(CHANGELOG, '1.10.0')).toMatch(/unreleased/);
    expect(releaseProblem('## 1.3.0\n\nText.\n', '1.3.0')).toMatch(/date/);
    expect(releaseProblem('## 1.3.0 (2026-12-01)\n\n## 1.2.0 (2026-11-23)\n', '1.3.0')).toMatch(/empty/);
    expect(releaseProblem(CHANGELOG, '1.2.0-beta')).toMatch(/not a release version/);
  });
});

describe('absolutizeLinks', () => {
  it('points repository files at the tag and leaves everything else alone', () => {
    const md = '[a](README.md#lighting) [b](./docs/REAL_DATA.md) [c](https://example.org/x) [d](#top) [e](mailto:a@example.org) [f](../x.md)';
    expect(absolutizeLinks(md, REPO, 'v1.2.0')).toBe(
      '[a](https://github.com/lance-lii/gaze-reader/blob/v1.2.0/README.md#lighting) ' +
        '[b](https://github.com/lance-lii/gaze-reader/blob/v1.2.0/docs/REAL_DATA.md) ' +
        '[c](https://example.org/x) [d](#top) [e](mailto:a@example.org) [f](../x.md)',
    );
  });
});

describe('releaseNotes', () => {
  const zip = { name: 'gaze-reader-extension-v1.2.0.zip', sha256: 'ab'.repeat(32) };

  it('says where to get the version, then what changed', () => {
    const notes = releaseNotes({ changelog: CHANGELOG, version: '1.2.0', repo: REPO, site: SITE, zip });
    expect(notes).toContain(`<${SITE}>`);
    expect(notes).toContain('`gaze-reader-extension-v1.2.0.zip`');
    expect(notes).toContain(zip.sha256);
    expect(notes).toContain('blob/v1.2.0/docs/INSTALL-EXTENSION.md');
    expect(notes).toContain('## What changed in 1.2.0\n\nSteadier tracking.');
    expect(notes).toContain('(https://github.com/lance-lii/gaze-reader/blob/v1.2.0/README.md#lighting)');
    expect(notes).not.toContain('Lighting.\n');
    expect(notes).not.toContain('Later.');
  });

  it('without a zip, sends the reader to the build instructions', () => {
    const notes = releaseNotes({ changelog: CHANGELOG, version: '1.2.0', repo: REPO, site: SITE, zip: null });
    expect(notes).toContain('[build and install it]');
    expect(notes).not.toContain('SHA-256');
  });

  it('refuses a version that is not ready, and notes GitHub would refuse', () => {
    expect(() => releaseNotes({ changelog: CHANGELOG, version: '1.10.0', repo: REPO, site: SITE, zip })).toThrow(/unreleased/);
    const long = `## 3.0.0 (2027-01-01)\n\n${'x'.repeat(MAX_RELEASE_BODY)}\n`;
    expect(() => releaseNotes({ changelog: long, version: '3.0.0', repo: REPO, site: SITE, zip })).toThrow(/GitHub allows/);
  });
});

describe('this repository', () => {
  // The project has no Node typings: read through Node's built-in module loader, as tests/appCss.test.ts does.
  interface FsLike {
    readFileSync(path: URL, encoding: 'utf8'): string;
  }
  const proc = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process;
  const fs = proc?.getBuiltinModule?.('node:fs') as FsLike | undefined;
  if (!fs) throw new Error('This test needs Node 22.3+ (process.getBuiltinModule).');
  const read = (path: string) => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
  const version: string = JSON.parse(read('package.json')).version;

  it('describes the version in package.json in the changelog, in a release that fits', () => {
    const section = changelogSection(read('CHANGELOG.md'), version);
    expect(section, `CHANGELOG.md needs a "## ${version}" section`).not.toBeNull();
    // A version still being worked on may be marked unreleased; a dated one must make a release.
    if (section && !/unreleased/i.test(section.note)) {
      expect(() => releaseNotes({ changelog: read('CHANGELOG.md'), version, repo: REPO, site: SITE, zip: null })).not.toThrow();
    }
  });

  it('gives the extension manifest and the lockfile the same version', () => {
    expect(JSON.parse(read('extension/manifest.json')).version).toBe(version);
    expect(JSON.parse(read('package-lock.json')).version).toBe(version);
  });
});
