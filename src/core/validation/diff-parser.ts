/**
 * Parse a unified diff string into structured file-level information.
 * Used by file scope validator to check what files were actually modified.
 */

import type { DiffFile } from './file-scope-validator.js';

/**
 * Parse a unified diff output (from `git diff`) into file-level summaries.
 */
export const parseDiff = (diffOutput: string): DiffFile[] => {
  if (!diffOutput.trim()) return [];

  const files: DiffFile[] = [];
  const fileSections = diffOutput.split(/^diff --git /m).filter(Boolean);

  for (const section of fileSections) {
    const file = parseFileSection(section);
    if (file) files.push(file);
  }

  return files;
};

const parseFileSection = (section: string): DiffFile | null => {
  const lines = section.split('\n');

  // Extract file path from "a/path b/path" or "--- a/path" / "+++ b/path"
  const path = extractFilePath(lines);
  if (!path) return null;

  const isNew = section.includes('new file mode');
  let linesAdded = 0;
  let linesRemoved = 0;

  for (const line of lines) {
    if (line.startsWith('+') && !line.startsWith('+++')) {
      linesAdded++;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      linesRemoved++;
    }
  }

  return { path, isNew, linesAdded, linesRemoved };
};

const extractFilePath = (lines: string[]): string | null => {
  // Try "+++ b/path" line first (most reliable)
  for (const line of lines) {
    if (line.startsWith('+++ b/')) {
      return line.slice(6);
    }
  }

  // Fallback: parse the "a/path b/path" header
  const header = lines[0];
  if (!header) return null;
  const match = header.match(/b\/(.+)$/);
  return match?.[1] ?? null;
};
