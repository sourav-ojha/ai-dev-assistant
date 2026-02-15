/**
 * File scope enforcement — CRITICAL.
 *
 * After code generation, validates that:
 * 1. All modified files are within the step's allowed scope
 * 2. No new files created unless explicitly allowed
 * 3. Diff is not too large (max lines / max files)
 *
 * Violations → task pauses immediately. No exceptions.
 */

import type { PlanStep } from '../entities/plan.js';

export interface DiffFile {
  path: string;
  isNew: boolean;
  linesAdded: number;
  linesRemoved: number;
}

export interface ScopeViolation {
  type: 'unauthorized_file' | 'new_file_not_allowed' | 'diff_too_large' | 'too_many_files';
  detail: string;
}

const MAX_DIFF_LINES = 200;
const MAX_FILES_MODIFIED = 3;

/**
 * Validate that all modified files are within the step's allowed scope.
 * Returns an empty array if valid, or a list of violations if not.
 */
export const validateFileScope = (
  step: PlanStep,
  modifiedFiles: DiffFile[],
): ScopeViolation[] => {
  const violations: ScopeViolation[] = [];

  // Check total diff size
  const totalLines = modifiedFiles.reduce((sum, f) => sum + f.linesAdded + f.linesRemoved, 0);
  if (totalLines > MAX_DIFF_LINES) {
    violations.push({
      type: 'diff_too_large',
      detail: `Diff is ${totalLines} lines (max ${MAX_DIFF_LINES})`,
    });
  }

  // Check file count
  if (modifiedFiles.length > MAX_FILES_MODIFIED) {
    violations.push({
      type: 'too_many_files',
      detail: `${modifiedFiles.length} files modified (max ${MAX_FILES_MODIFIED})`,
    });
  }

  for (const file of modifiedFiles) {
    // Check new file permission
    if (file.isNew && !step.newFilesAllowed) {
      violations.push({
        type: 'new_file_not_allowed',
        detail: `New file "${file.path}" created but newFilesAllowed=false`,
      });
      continue;
    }

    // Check against allowed files list (exact match)
    if (step.allowedFiles.includes(file.path)) {
      continue;
    }

    // Check against allowed globs
    if (matchesAnyGlob(file.path, step.allowedGlobs)) {
      continue;
    }

    // New files that are allowed don't need to match existing file lists
    if (file.isNew && step.newFilesAllowed) {
      continue;
    }

    violations.push({
      type: 'unauthorized_file',
      detail: `File "${file.path}" is not in allowed scope [${step.allowedFiles.join(', ')}]`,
    });
  }

  return violations;
};

/**
 * Simple glob matching — supports * and ** patterns.
 * For v1, this is intentionally basic. No external glob library needed.
 */
const matchesAnyGlob = (filePath: string, globs: string[]): boolean => {
  for (const glob of globs) {
    if (matchGlob(filePath, glob)) return true;
  }
  return false;
};

const matchGlob = (filePath: string, glob: string): boolean => {
  // Convert glob to regex
  const regexStr = glob
    .replace(/\./g, '\\.')
    .replace(/\*\*/g, '{{GLOBSTAR}}')
    .replace(/\*/g, '[^/]*')
    .replace(/\{\{GLOBSTAR\}\}/g, '.*');

  return new RegExp(`^${regexStr}$`).test(filePath);
};
