/**
 * Git operations adapter.
 * Handles repo structure reading, branch creation, and diff collection.
 * Runs git commands on the host (not inside containers).
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { createLogger } from "../logger.js";

const log = createLogger("git-adapter");

/**
 * Get a compact representation of the repo file structure.
 * Used as context for the planner to understand what files exist.
 */
export const getRepoStructure = (
  repoPath: string,
  maxDepth: number = 4,
): string => {
  if (!existsSync(repoPath)) {
    throw new Error(`Repo path does not exist: ${repoPath}`);
  }

  const lines: string[] = [];
  walkDir(repoPath, repoPath, 0, maxDepth, lines);
  return lines.join("\n");
};

/**
 * Read file contents for specific paths within the repo.
 * Used to provide scoped context to the code generator.
 */
export const readFiles = (
  repoPath: string,
  filePaths: string[],
): Array<{ path: string; content: string }> => {
  const results: Array<{ path: string; content: string }> = [];

  for (const filePath of filePaths) {
    const fullPath = join(repoPath, filePath);
    if (existsSync(fullPath)) {
      try {
        const content = readFileSync(fullPath, "utf-8");
        results.push({ path: filePath, content });
      } catch (err) {
        log.warn({ filePath, error: err }, "Failed to read file");
      }
    }
  }

  return results;
};

/**
 * Create a feature branch name from a task ID and goal.
 */
export const createBranchName = (taskId: string, goal: string): string => {
  const slug = goal
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);

  return `ai/${taskId.slice(0, 8)}/${slug}`;
};

/**
 * Clone a repo to a local workspace directory.
 */
export const cloneRepo = (
  repoUrl: string,
  destPath: string,
  branch?: string,
): void => {
  const branchFlag = branch ? `--branch ${branch}` : "";
  execSync(`git clone --depth 1 ${branchFlag} ${repoUrl} ${destPath}`, {
    stdio: "pipe",
    timeout: 60_000,
  });
  log.info({ repoUrl, destPath }, "Repo cloned");
};

/**
 * Create and checkout a new branch in a local repo.
 */
export const checkoutNewBranch = (
  repoPath: string,
  branchName: string,
): void => {
  execSync(`git checkout -b ${branchName}`, {
    cwd: repoPath,
    stdio: "pipe",
  });
  log.info({ repoPath, branchName }, "Branch created");
};

// === Mutation operations ===

/**
 * Stage all changes and commit with the given message.
 */
export const commitChanges = (repoPath: string, message: string): void => {
  try {
    // Stage all changes (including new files and deletions)
    execSync("git add -A", { cwd: repoPath, stdio: "pipe" });

    // Check if there are changes to commit
    const status = execSync("git status --porcelain", {
      cwd: repoPath,
      encoding: "utf-8",
    });
    if (!status.trim()) {
      log.info({ repoPath }, "No changes to commit");
      return;
    }

    // Commit
    execSync(`git commit -m "${message}"`, { cwd: repoPath, stdio: "pipe" });
    log.info({ repoPath, message }, "Changes committed");
  } catch (err) {
    log.error({ repoPath, error: err }, "Failed to commit changes");
    throw new Error(
      `Git commit failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
};

/**
 * Push the current branch to origin.
 */
export const pushBranch = (repoPath: string, branchName: string): void => {
  try {
    execSync(`git push -u origin ${branchName}`, {
      cwd: repoPath,
      stdio: "pipe",
    });
    log.info({ repoPath, branchName }, "Branch pushed to origin");
  } catch (err) {
    log.error({ repoPath, branchName, error: err }, "Failed to push branch");
    throw new Error(
      `Git push failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
};

/**
 * Check if GitHub CLI (gh) is installed.
 */
export const checkGhInstalled = (): boolean => {
  try {
    execSync("gh --version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

/**
 * Check if GitHub CLI is authenticated.
 */
export const checkGhAuth = (): boolean => {
  try {
    // If GH_TOKEN is set, gh CLI uses it automatically
    if (process.env.GH_TOKEN) return true;

    // Otherwise check auth status
    execSync("gh auth status", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

export class GhCliNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GhCliNotConfiguredError";
  }
}

/**
 * Create a pull request using GitHub CLI.
 */
export const createPullRequest = (
  repoPath: string,
  title: string,
  body: string,
): string => {
  if (!checkGhInstalled()) {
    throw new GhCliNotConfiguredError("GitHub CLI (gh) is not installed");
  }

  if (!checkGhAuth()) {
    throw new GhCliNotConfiguredError("GitHub CLI (gh) is not authenticated");
  }

  try {
    // Create PR
    // --web: open in browser? No, we just want the URL.
    // --head: current branch is inferred
    // --base: repository default branch (usually main/master) is inferred
    const output = execSync(
      `gh pr create --title "${title.replace(/"/g, '\\"')}" --body "${body.replace(/"/g, '\\"')}"`,
      {
        cwd: repoPath,
        encoding: "utf-8",
      },
    );

    const prUrl = output.trim();
    log.info({ repoPath, prUrl }, "Pull request created");
    return prUrl;
  } catch (err) {
    log.error({ repoPath, error: err }, "Failed to create PR");
    throw new Error(
      `Failed to create PR: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
};

// === Internal helpers ===

const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".cache",
  "coverage",
  ".nyc_output",
  ".yarn",
  ".pnp.cjs",
  "__pycache__",
]);

const walkDir = (
  basePath: string,
  dirPath: string,
  depth: number,
  maxDepth: number,
  lines: string[],
): void => {
  if (depth > maxDepth) return;

  const entries = readdirSync(dirPath).sort();
  const indent = "  ".repeat(depth);

  for (const entry of entries) {
    if (IGNORE_DIRS.has(entry) || entry.startsWith(".")) continue;

    const fullPath = join(dirPath, entry);
    const relPath = relative(basePath, fullPath);
    const stat = statSync(fullPath);

    if (stat.isDirectory()) {
      lines.push(`${indent}${entry}/`);
      walkDir(basePath, fullPath, depth + 1, maxDepth, lines);
    } else {
      lines.push(`${indent}${entry}`);
    }
  }
};
