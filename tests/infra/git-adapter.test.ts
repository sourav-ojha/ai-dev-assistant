/**
 * Tests for the Git adapter — real git operations.
 * Clones a small public repo, reads structure, creates branches.
 * No AI API calls.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import {
  getRepoStructure,
  readFiles,
  createBranchName,
  cloneRepo,
  checkoutNewBranch,
} from '../../src/infrastructure/git/git-adapter.js';

const WORKSPACE_ROOT = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
const TEST_DIR = join(WORKSPACE_ROOT, '.test-tmp', 'git');

describe('Git Adapter — createBranchName', () => {
  it('should create a slug from task ID and goal', () => {
    const branch = createBranchName('abcd1234-5678-efgh', 'Add readme.md with standard details');
    expect(branch).toBe('ai/abcd1234/add-readme-md-with-standard-details');
  });

  it('should truncate long goals to 40 chars', () => {
    const branch = createBranchName('abcd1234', 'This is a very long goal description that should be truncated at forty characters');
    expect(branch.length).toBeLessThanOrEqual(52); // ai/abcd1234/ = 12 + 40
  });

  it('should strip special characters', () => {
    const branch = createBranchName('abcd1234', 'Fix bug #123: handle @mentions & emails!');
    expect(branch).toMatch(/^ai\/abcd1234\/[a-z0-9-]+$/);
  });
});

describe('Git Adapter — getRepoStructure', () => {
  const repoDir = join(TEST_DIR, 'structure-test');

  beforeAll(() => {
    // Create a fake repo directory with some structure
    rmSync(repoDir, { recursive: true, force: true });
    mkdirSync(join(repoDir, 'src', 'components'), { recursive: true });
    mkdirSync(join(repoDir, 'src', 'utils'), { recursive: true });
    mkdirSync(join(repoDir, 'tests'), { recursive: true });

    writeFileSync(join(repoDir, 'package.json'), '{}');
    writeFileSync(join(repoDir, 'README.md'), '# Test');
    writeFileSync(join(repoDir, 'src', 'index.ts'), 'export {}');
    writeFileSync(join(repoDir, 'src', 'components', 'App.tsx'), '<App/>');
    writeFileSync(join(repoDir, 'src', 'utils', 'helpers.ts'), 'export {}');
    writeFileSync(join(repoDir, 'tests', 'app.test.ts'), 'test()');

    // Also add node_modules which should be ignored
    mkdirSync(join(repoDir, 'node_modules', 'foo'), { recursive: true });
    writeFileSync(join(repoDir, 'node_modules', 'foo', 'index.js'), '');
  });

  afterAll(() => {
    rmSync(repoDir, { recursive: true, force: true });
  });

  it('should return repo structure as a string', () => {
    const structure = getRepoStructure(repoDir);
    expect(structure).toContain('src/');
    expect(structure).toContain('package.json');
    expect(structure).toContain('README.md');
  });

  it('should include nested directories', () => {
    const structure = getRepoStructure(repoDir);
    expect(structure).toContain('components/');
    expect(structure).toContain('App.tsx');
    expect(structure).toContain('utils/');
    expect(structure).toContain('helpers.ts');
  });

  it('should ignore node_modules', () => {
    const structure = getRepoStructure(repoDir);
    expect(structure).not.toContain('node_modules');
    expect(structure).not.toContain('foo');
  });

  it('should ignore .git directories', () => {
    // Init a git repo to create .git
    execSync('git init', { cwd: repoDir, stdio: 'pipe' });
    const structure = getRepoStructure(repoDir);
    expect(structure).not.toContain('.git');
  });

  it('should throw for non-existent path', () => {
    expect(() => getRepoStructure('/tmp/nonexistent-path-xyz')).toThrow('does not exist');
  });
});

describe('Git Adapter — readFiles', () => {
  const repoDir = join(TEST_DIR, 'readfiles-test');

  beforeAll(() => {
    rmSync(repoDir, { recursive: true, force: true });
    mkdirSync(join(repoDir, 'src'), { recursive: true });
    writeFileSync(join(repoDir, 'src', 'index.ts'), 'console.log("hello");');
    writeFileSync(join(repoDir, 'src', 'utils.ts'), 'export const add = (a: number, b: number) => a + b;');
    writeFileSync(join(repoDir, 'package.json'), '{"name": "test"}');
  });

  afterAll(() => {
    rmSync(repoDir, { recursive: true, force: true });
  });

  it('should read existing files', () => {
    const results = readFiles(repoDir, ['src/index.ts', 'package.json']);
    expect(results).toHaveLength(2);
    expect(results[0].path).toBe('src/index.ts');
    expect(results[0].content).toContain('console.log');
    expect(results[1].path).toBe('package.json');
    expect(results[1].content).toContain('"name"');
  });

  it('should skip non-existent files without error', () => {
    const results = readFiles(repoDir, ['src/index.ts', 'does-not-exist.ts']);
    expect(results).toHaveLength(1);
    expect(results[0].path).toBe('src/index.ts');
  });

  it('should return empty array for all missing files', () => {
    const results = readFiles(repoDir, ['nope.ts', 'also-nope.ts']);
    expect(results).toHaveLength(0);
  });
});

describe('Git Adapter — cloneRepo + checkoutNewBranch', () => {
  const cloneDir = join(TEST_DIR, 'clone-test');
  // Use a tiny, well-known public repo for cloning
  const TEST_REPO = 'https://github.com/octocat/Hello-World.git';

  beforeAll(() => {
    rmSync(cloneDir, { recursive: true, force: true });
    mkdirSync(cloneDir, { recursive: true });
  });

  afterAll(() => {
    rmSync(cloneDir, { recursive: true, force: true });
  });

  it('should clone a public repo', () => {
    const dest = join(cloneDir, 'repo');
    cloneRepo(TEST_REPO, dest);

    expect(existsSync(dest)).toBe(true);
    expect(existsSync(join(dest, '.git'))).toBe(true);
  });

  it('should checkout a new branch on a cloned repo', () => {
    const dest = join(cloneDir, 'repo');
    checkoutNewBranch(dest, 'ai/test-branch');

    const currentBranch = execSync('git branch --show-current', {
      cwd: dest,
      encoding: 'utf-8',
    }).trim();

    expect(currentBranch).toBe('ai/test-branch');
  });

  it('should read structure of cloned repo', () => {
    const dest = join(cloneDir, 'repo');
    const structure = getRepoStructure(dest);

    // Hello-World repo has a README
    expect(structure).toContain('README');
  });
});
