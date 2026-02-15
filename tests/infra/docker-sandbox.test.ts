/**
 * Tests for Docker sandbox runner — real Docker operations.
 * Requires Docker daemon to be running.
 * No AI API calls.
 *
 * These tests verify:
 * 1. Docker image exists (ai-dev-sandbox:latest)
 * 2. Container creation + startup
 * 3. Executing commands inside container
 * 4. Applying code changes via the --- FILE: --- format
 * 5. Git operations inside container
 * 6. Container cleanup
 */

import { describe, it, expect, beforeAll } from 'vitest';
import Docker from 'dockerode';
import { execSync } from 'node:child_process';
import { DockerSandboxRunner } from '../../src/infrastructure/docker/docker-sandbox-runner.js';
import { createPlanStep } from '../../src/core/entities/plan.js';
import type { SandboxConfig } from '../../src/core/ports/sandbox-runner.js';

const DOCKER_SOCKET = '/var/run/docker.sock';
const SANDBOX_IMAGE = 'ai-dev-sandbox:latest';
const TEST_REPO = 'https://github.com/octocat/Hello-World.git';

let dockerAvailable = false;
let imageExists = false;

beforeAll(async () => {
  // Check if Docker is available
  try {
    const docker = new Docker({ socketPath: DOCKER_SOCKET });
    await docker.ping();
    dockerAvailable = true;

    // Check if sandbox image exists
    try {
      await docker.getImage(SANDBOX_IMAGE).inspect();
      imageExists = true;
    } catch {
      // Image doesn't exist — we'll build it
      console.log(`Image ${SANDBOX_IMAGE} not found. Building...`);
      try {
        execSync('docker build -t ai-dev-sandbox:latest -f docker/sandbox.Dockerfile .', {
          cwd: process.cwd(),
          stdio: 'pipe',
          timeout: 120_000,
        });
        imageExists = true;
        console.log('Image built successfully.');
      } catch (buildErr) {
        console.warn('Failed to build sandbox image:', buildErr);
      }
    }
  } catch {
    console.warn('Docker daemon not available — Docker tests will be skipped');
  }
});

describe('Docker — Prerequisites', () => {
  it('should have Docker daemon running', () => {
    if (!dockerAvailable) {
      console.warn('SKIPPED: Docker daemon not available');
      return;
    }
    expect(dockerAvailable).toBe(true);
  });

  it('should have sandbox image available', () => {
    if (!dockerAvailable || !imageExists) {
      console.warn('SKIPPED: Sandbox image not available');
      return;
    }
    expect(imageExists).toBe(true);
  });
});

describe('Docker — Raw Container Lifecycle', () => {
  it.skipIf(!dockerAvailable || !imageExists)('should create, start, exec, and destroy a container', async () => {
    const docker = new Docker({ socketPath: DOCKER_SOCKET });

    // Create container
    const container = await docker.createContainer({
      Image: SANDBOX_IMAGE,
      Cmd: ['sleep', '60'],
      HostConfig: {
        Memory: 256 * 1024 * 1024,
        NanoCpus: 1e9,
        NetworkMode: 'bridge', // Need network for git clone in test
        AutoRemove: false,
      },
      WorkingDir: '/workspace',
    });

    const containerId = container.id.slice(0, 12);
    console.log(`Container created: ${containerId}`);

    try {
      await container.start();

      // Verify container is running
      const info = await container.inspect();
      expect(info.State.Running).toBe(true);

      // Execute a simple command
      const exec = await container.exec({
        Cmd: ['echo', 'hello from container'],
        AttachStdout: true,
        AttachStderr: true,
      });

      const stream = await exec.start({ Detach: false });
      const output = await collectStream(stream);
      expect(output).toContain('hello from container');

      // Verify git is available
      const gitExec = await container.exec({
        Cmd: ['git', '--version'],
        AttachStdout: true,
        AttachStderr: true,
      });

      const gitStream = await gitExec.start({ Detach: false });
      const gitOutput = await collectStream(gitStream);
      expect(gitOutput).toContain('git version');

      // Verify node is available
      const nodeExec = await container.exec({
        Cmd: ['node', '--version'],
        AttachStdout: true,
        AttachStderr: true,
      });

      const nodeStream = await nodeExec.start({ Detach: false });
      const nodeOutput = await collectStream(nodeStream);
      expect(nodeOutput).toMatch(/v\d+\.\d+\.\d+/);

      console.log(`Container test passed: ${containerId}`);
    } finally {
      // Cleanup
      try { await container.stop({ t: 2 }); } catch { /* ok */ }
      try { await container.remove({ force: true }); } catch { /* ok */ }
      console.log(`Container destroyed: ${containerId}`);
    }
  });
});

describe('Docker — Git Clone Inside Container', () => {
  it.skipIf(!dockerAvailable || !imageExists)('should clone a repo inside a container', async () => {
    const docker = new Docker({ socketPath: DOCKER_SOCKET });

    const container = await docker.createContainer({
      Image: SANDBOX_IMAGE,
      Cmd: ['sleep', '120'],
      HostConfig: {
        Memory: 256 * 1024 * 1024,
        NanoCpus: 1e9,
        NetworkMode: 'bridge', // Need network for git clone
        AutoRemove: false,
      },
      WorkingDir: '/workspace',
    });

    try {
      await container.start();

      // Clone the test repo
      const cloneExec = await container.exec({
        Cmd: ['sh', '-c', `git clone --depth 1 ${TEST_REPO} /workspace/repo 2>&1`],
        AttachStdout: true,
        AttachStderr: true,
      });

      const cloneStream = await cloneExec.start({ Detach: false });
      const cloneOutput = await collectStream(cloneStream);
      console.log('Clone output:', cloneOutput.trim());

      // Verify repo was cloned
      const lsExec = await container.exec({
        Cmd: ['ls', '/workspace/repo'],
        AttachStdout: true,
        AttachStderr: true,
      });

      const lsStream = await lsExec.start({ Detach: false });
      const lsOutput = await collectStream(lsStream);
      expect(lsOutput).toContain('README');

      // Create a new branch
      const branchExec = await container.exec({
        Cmd: ['sh', '-c', 'cd /workspace/repo && git checkout -b ai/test-branch 2>&1'],
        AttachStdout: true,
        AttachStderr: true,
      });

      const branchStream = await branchExec.start({ Detach: false });
      const branchOutput = await collectStream(branchStream);
      expect(branchOutput).toContain('ai/test-branch');

    } finally {
      try { await container.stop({ t: 2 }); } catch { /* ok */ }
      try { await container.remove({ force: true }); } catch { /* ok */ }
    }
  });
});

describe('Docker — Code Application Inside Container', () => {
  it.skipIf(!dockerAvailable || !imageExists)('should write files using --- FILE: --- format inside container', async () => {
    const docker = new Docker({ socketPath: DOCKER_SOCKET });

    const container = await docker.createContainer({
      Image: SANDBOX_IMAGE,
      Cmd: ['sleep', '60'],
      HostConfig: {
        Memory: 256 * 1024 * 1024,
        NanoCpus: 1e9,
        NetworkMode: 'bridge',
        AutoRemove: false,
      },
      WorkingDir: '/workspace',
    });

    try {
      await container.start();

      // Clone test repo
      await execInContainer(container, `git clone --depth 1 ${TEST_REPO} /workspace/repo 2>&1`);

      // Write a new file using the same mechanism the sandbox runner uses
      const fileContent = '# Hello World\\n\\nThis is a test README generated by AI Dev Assistant.';
      await execInContainer(container, `mkdir -p /workspace/repo`);
      await execInContainer(
        container,
        `cat > /workspace/repo/NEW_FILE.md << 'ENDOFFILE'\n# Hello World\n\nThis is a test README generated by AI Dev Assistant.\nENDOFFILE`
      );

      // Verify the file was written
      const readOutput = await execInContainer(container, 'cat /workspace/repo/NEW_FILE.md');
      expect(readOutput).toContain('Hello World');
      expect(readOutput).toContain('AI Dev Assistant');

      // Verify git diff works
      await execInContainer(container, 'cd /workspace/repo && git add -A');
      const diffOutput = await execInContainer(container, 'cd /workspace/repo && git diff --cached');
      expect(diffOutput).toContain('NEW_FILE.md');
      expect(diffOutput).toContain('+# Hello World');

    } finally {
      try { await container.stop({ t: 2 }); } catch { /* ok */ }
      try { await container.remove({ force: true }); } catch { /* ok */ }
    }
  });
});

describe('Docker — Full SandboxRunner.executeStep', () => {
  it.skipIf(!dockerAvailable || !imageExists)('should execute a step end-to-end via DockerSandboxRunner', async () => {
    const runner = new DockerSandboxRunner(DOCKER_SOCKET, SANDBOX_IMAGE);

    const step = createPlanStep(
      0,
      'Create a new file',
      'Create NEW_FILE.md in repo root',
      'Write a markdown file',
      ['NEW_FILE.md'],
      { newFilesAllowed: true },
    );

    const generatedCode = `--- FILE: NEW_FILE.md ---
# Test File

Created by DockerSandboxRunner test.
This verifies the full sandbox execution pipeline.
--- END FILE ---`;

    const config: SandboxConfig = {
      repoUrl: TEST_REPO,
      branch: 'master',
      timeoutSec: 120,
      memoryMb: 256,
      cpuCount: 1,
    };

    const result = await runner.executeStep(step, generatedCode, config);

    console.log('executeStep result:', {
      success: result.success,
      filesModified: result.filesModified,
      linesChanged: result.linesChanged,
      durationMs: result.durationMs,
      testOutput: result.testOutput.slice(0, 200),
      error: result.error,
    });

    // The step should complete (even if tests "fail" because Hello-World has no tests)
    expect(result.diff).toContain('NEW_FILE.md');
    expect(result.diff).toContain('Test File');
    expect(result.filesModified).toContain('NEW_FILE.md');
    expect(result.linesChanged).toBeGreaterThan(0);
    expect(result.durationMs).toBeGreaterThan(0);
  });
});

// === Helpers ===

const execInContainer = async (container: Docker.Container, cmd: string): Promise<string> => {
  const exec = await container.exec({
    Cmd: ['sh', '-c', cmd],
    AttachStdout: true,
    AttachStderr: true,
  });
  const stream = await exec.start({ Detach: false });
  return collectStream(stream);
};

const collectStream = (stream: NodeJS.ReadableStream): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    stream.on('error', reject);
  });
