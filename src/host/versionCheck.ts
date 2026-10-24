// Log-only sanity check: does the Claude Code that will be spawned match the one the bundled Agent SDK was built for?
// Pure apart from the optional file reads, which are injected. No `vscode` import.
import * as path from 'node:path';

export interface MajorMinor {
  major: number;
  minor: number;
}

/** `2.1.302` (or `v2.1.302-beta`) gives {2, 1}; anything else gives undefined. */
export function parseMajorMinor(version: string | undefined): MajorMinor | undefined {
  if (version === undefined) return undefined;
  const m = /(\d+)\.(\d+)(?:\.\d+)?/.exec(version);
  return m ? { major: Number(m[1]), minor: Number(m[2]) } : undefined;
}

export type VersionVerdict = 'match' | 'mismatch' | 'unknown';

/** Same major.minor is a match. Missing or unparsable input is unknown. */
export function compareMajorMinor(a: string | undefined, b: string | undefined): VersionVerdict {
  const x = parseMajorMinor(a);
  const y = parseMajorMinor(b);
  if (!x || !y) return 'unknown';
  return x.major === y.major && x.minor === y.minor ? 'match' : 'mismatch';
}

/** The extension folder behind `<ext>/resources/native-binary/claude[.exe]`, or undefined for any other path. */
export function extensionRootOfBinary(binaryPath: string): string | undefined {
  const norm = binaryPath.replace(/\\/g, '/');
  const m = /^(.*)\/resources\/native-binary\/[^/]+$/.exec(norm);
  if (!m) return undefined;
  // Keep the caller's separators.
  return binaryPath.slice(0, m[1]!.length);
}

export interface VersionCheckInput {
  /** What supplied the binary: 'extension', 'setting', 'local-bin' or 'path'. */
  source: string;
  binaryPath: string;
  /** The SDK's own version, and the Claude Code version it was built for (from its package.json). */
  sdkVersion: string | undefined;
  sdkClaudeCodeVersion: string | undefined;
  readFile: (p: string) => string | undefined;
}

export interface VersionCheckResult {
  /** One or two plain log lines. */
  lines: string[];
  /** True when a warning should be logged (major.minor differ). */
  warn: boolean;
}

/** Version of the Claude Code extension that holds `binaryPath`: its package.json, else the folder name. */
export function claudeCodeExtensionVersion(root: string, readFile: (p: string) => string | undefined): string | undefined {
  const raw = readFile(path.join(root, 'package.json'));
  if (raw !== undefined) {
    try {
      const v = (JSON.parse(raw) as { version?: unknown }).version;
      if (typeof v === 'string' && parseMajorMinor(v)) return v;
    } catch {
      // fall through to the folder name
    }
  }
  const folder = path.basename(root);
  const m = /-(\d+\.\d+\.\d+)(?:-|$)/.exec(folder);
  return m ? m[1] : undefined;
}

export function checkClaudeVersions(input: VersionCheckInput): VersionCheckResult {
  const sdkPart = `Agent SDK ${input.sdkVersion ?? 'unknown'} (built for Claude Code ${input.sdkClaudeCodeVersion ?? 'unknown'})`;
  const root = input.source === 'extension' ? extensionRootOfBinary(input.binaryPath) : undefined;
  if (root === undefined) {
    return { lines: [`Claude binary from ${input.source}; its version is not checked at startup. ${sdkPart}.`], warn: false };
  }
  const ext = claudeCodeExtensionVersion(root, input.readFile);
  const verdict = compareMajorMinor(ext, input.sdkClaudeCodeVersion);
  const base = `Claude Code extension ${ext ?? 'unknown version'} supplies the binary; ${sdkPart}.`;
  if (verdict === 'mismatch') {
    return {
      lines: [`${base} Versions differ in major.minor, so the office may behave unexpectedly; update Middle Management or the Claude Code extension.`],
      warn: true,
    };
  }
  return { lines: [base], warn: false };
}
