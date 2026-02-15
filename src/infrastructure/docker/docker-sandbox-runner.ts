/**
 * Docker sandbox runner — dockerode.
 * Each step executes in an ephemeral container.
 *
 * Flow per step:
 * 1. Create container with resource limits
 * 2. Clone repo + checkout branch
 * 3. Apply generated code changes
 * 4. Run tests
 * 5. Collect diff + test output
 * 6. Destroy container
 */

import Docker from 'dockerode';
import type { ISandboxRunner, SandboxConfig, StepExecutionResult } from '../../core/ports/sandbox-runner.js';
import type { PlanStep } from '../../core/entities/plan.js';
import { createLogger } from '../logger.js';

const log = createLogger('docker-sandbox');

export class DockerSandboxRunner implements ISandboxRunner {
  private docker: Docker;
  private image: string;

  constructor(socketPath: string, image: string) {
    this.docker = new Docker({ socketPath });
    this.image = image;
  }

  async executeStep(
    step: PlanStep,
    generatedCode: string,
    config: SandboxConfig,
  ): Promise<StepExecutionResult> {
    const start = Date.now();

    const container = await this.createContainer(config);
    const containerId = container.id.slice(0, 12);

    log.info({ containerId, step: step.index }, 'Container created');

    try {
      await container.start();

      // 1. Clone and checkout (requires network for GitHub)
      const cloneOutput = await this.exec(container, [
        'sh', '-c',
        `git clone --depth 1 ${config.repoUrl} /workspace/repo 2>&1 && cd /workspace/repo && (git checkout -b ${config.branch} 2>/dev/null || git checkout ${config.branch} 2>/dev/null || true)`,
      ]);

      const repoExists = await this.exec(container, ['sh', '-c', 'test -d /workspace/repo && echo ok']);
      if (!repoExists.trim().endsWith('ok')) {
        throw new Error(`Git clone failed. Repo not found at /workspace/repo. Output: ${cloneOutput.slice(0, 500)}`);
      }

      // 2. Apply code changes
      await this.applyCodeChanges(container, generatedCode);

      // 3. Install dependencies — detect package manager (yarn all versions, npm) then install
      const installScript = `
        cd /workspace/repo
        corepack enable 2>/dev/null || true
        if node -e "
          const fs = require('fs');
          const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
          const pm = (pkg.packageManager || '').split('@')[0];
          if (pm === 'yarn') { process.exit(0); } else { process.exit(1); }
        " 2>/dev/null; then
          yarn install 2>&1
        elif [ -f yarn.lock ] || [ -f .yarnrc.yml ]; then
          yarn install 2>&1
        elif [ -f package-lock.json ]; then
          npm ci 2>&1
        else
          npm install 2>&1
        fi
      `;
      const installOutput = await this.exec(container, ['sh', '-c', installScript]);
      if (installOutput.includes('ENOENT') || installOutput.includes('not found')) {
        log.warn({ containerId, installOutput: installOutput.slice(0, 300) }, 'Install had errors; continuing to run tests');
      }

      // 4. Run tests — same package manager as install
      const testScript = `
        cd /workspace/repo
        if node -e "
          const fs = require('fs');
          const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
          const pm = (pkg.packageManager || '').split('@')[0];
          if (pm === 'yarn') { process.exit(0); } else { process.exit(1); }
        " 2>/dev/null; then
          yarn test 2>&1
        elif [ -f yarn.lock ] || [ -f .yarnrc.yml ]; then
          yarn test 2>&1
        else
          npm test 2>&1
        fi || echo "NO_TEST_RUNNER_FOUND"
      `;
      const testOutput = await this.exec(container, ['sh', '-c', testScript]);

      // 5. Collect diff
      const diff = await this.exec(container, [
        'sh', '-c',
        'cd /workspace/repo && git add -A && git diff --cached',
      ]);

      // 6. Parse results
      const testsPassed = !testOutput.includes('FAIL') &&
        !testOutput.includes('Error') &&
        !testOutput.includes('NO_TEST_RUNNER_FOUND');

      const filesModified = extractModifiedFiles(diff);

      return {
        success: testsPassed,
        diff,
        testOutput,
        testsPassed,
        filesModified,
        linesChanged: countDiffLines(diff),
        exitCode: testsPassed ? 0 : 1,
        durationMs: Date.now() - start,
      };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      log.error({ containerId, error: errMsg }, 'Step execution failed');

      return {
        success: false,
        diff: '',
        testOutput: '',
        testsPassed: false,
        filesModified: [],
        linesChanged: 0,
        exitCode: 1,
        durationMs: Date.now() - start,
        error: errMsg,
      };
    } finally {
      await this.destroyContainer(container);
      log.info({ containerId, durationMs: Date.now() - start }, 'Container destroyed');
    }
  }

  private async createContainer(config: SandboxConfig): Promise<Docker.Container> {
    return this.docker.createContainer({
      Image: this.image,
      Cmd: ['sleep', String(config.timeoutSec)],
      HostConfig: {
        Memory: config.memoryMb * 1024 * 1024,
        NanoCpus: config.cpuCount * 1e9,
        NetworkMode: 'bridge', // Required for git clone from GitHub
        ReadonlyRootfs: false, // Need to write to /workspace
        AutoRemove: false,
      },
      WorkingDir: '/workspace',
    });
  }

  private async exec(container: Docker.Container, cmd: string[]): Promise<string> {
    const exec = await container.exec({
      Cmd: cmd,
      AttachStdout: true,
      AttachStderr: true,
    });

    const stream = await exec.start({ Detach: false });
    return collectStream(stream);
  }

  /**
   * Apply generated code to the repo inside the container.
   * Parses "--- FILE: path ---" markers and writes each file.
   */
  private async applyCodeChanges(container: Docker.Container, generatedCode: string): Promise<void> {
    const fileBlocks = parseGeneratedCode(generatedCode);

    for (const { path, content } of fileBlocks) {
      // Ensure directory exists, then write file
      const dir = path.split('/').slice(0, -1).join('/');
      if (dir) {
        await this.exec(container, ['sh', '-c', `mkdir -p /workspace/repo/${dir}`]);
      }

      // Write content via heredoc
      const escapedContent = content.replace(/'/g, "'\\''");
      await this.exec(container, [
        'sh', '-c',
        `cat > /workspace/repo/${path} << 'ENDOFFILE'\n${escapedContent}\nENDOFFILE`,
      ]);
    }
  }

  private async destroyContainer(container: Docker.Container): Promise<void> {
    try {
      await container.stop({ t: 2 });
    } catch {
      // Container may already be stopped
    }
    try {
      await container.remove({ force: true });
    } catch {
      // Container may already be removed
    }
  }
}

// === Helpers ===

interface FileBlock {
  path: string;
  content: string;
}

const parseGeneratedCode = (code: string): FileBlock[] => {
  const blocks: FileBlock[] = [];
  const regex = /--- FILE: (.+?) ---\n([\s\S]*?)--- END FILE ---/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(code)) !== null) {
    blocks.push({ path: match[1].trim(), content: match[2].trimEnd() });
  }

  return blocks;
};

const extractModifiedFiles = (diff: string): string[] => {
  const files: string[] = [];
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ b/')) {
      files.push(line.slice(6));
    }
  }
  return files;
};

const countDiffLines = (diff: string): number => {
  let count = 0;
  for (const line of diff.split('\n')) {
    if ((line.startsWith('+') && !line.startsWith('+++')) ||
        (line.startsWith('-') && !line.startsWith('---'))) {
      count++;
    }
  }
  return count;
};

const collectStream = (stream: NodeJS.ReadableStream): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    stream.on('error', reject);
  });
