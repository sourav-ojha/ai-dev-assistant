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

/**
 * Justification for extending scope to include an out-of-scope file.
 * Shown to the user when asking allow/revise so they know what changes and why.
 */
export interface ScopeExtensionJustification {
  /** File path that was modified outside allowed scope. */
  filePath: string;
  /** Summary of changes (e.g. "+5 -2 lines", "new file"). */
  changeSummary: string;
  /** Why this file was changed — ties to the step goal. */
  reason: string;
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
 * Returns true if the file is within the step's allowed scope.
 */
export const isFileInScope = (step: PlanStep, file: DiffFile): boolean => {
  if (file.isNew && !step.newFilesAllowed) return false;
  if (step.allowedFiles.includes(file.path)) return true;
  if (matchesAnyGlob(file.path, step.allowedGlobs)) return true;
  if (file.isNew && step.newFilesAllowed) return true;
  return false;
};

/**
 * Build justifications for each out-of-scope file: what changed and why (from step goal).
 * Used when asking the user to allow scope extension so they see what will change and why.
 */
export const buildScopeExtensionJustifications = (
  step: PlanStep,
  modifiedFiles: DiffFile[],
): ScopeExtensionJustification[] => {
  const reason = `Step: "${step.title}". ${step.description}`.trim();
  const out: ScopeExtensionJustification[] = [];

  for (const file of modifiedFiles) {
    if (isFileInScope(step, file)) continue;

    const changeSummary = file.isNew
      ? `New file (+${file.linesAdded} lines)`
      : `+${file.linesAdded} lines added, ${file.linesRemoved} removed`;
    out.push({
      filePath: file.path,
      changeSummary,
      reason,
    });
  }

  return out;
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
