#!/usr/bin/env node

/**
 * CLI entry point — commander.
 * Commands: submit, status, list, resume
 */

import { Command } from 'commander';
import { loadConfig, loadDbPath } from '../config/index.js';
import { SQLiteTaskStore } from '../infrastructure/persistence/sqlite-task-store.js';
import { ClaudeAdapter } from '../infrastructure/llm/claude-adapter.js';
import { TelegramAdapter } from '../infrastructure/telegram/telegram-adapter.js';
import { DockerSandboxRunner } from '../infrastructure/docker/docker-sandbox-runner.js';
import { TaskOrchestrator } from '../orchestrator/task-orchestrator.js';
import { TERMINAL_STATES } from '../core/entities/task.js';
import { createLogger } from '../infrastructure/logger.js';

const log = createLogger('cli');

const program = new Command();

program
  .name('ai-dev')
  .description('AI Developer Assistant — human-in-the-loop autonomous coding')
  .version('0.1.0');

// === submit ===

program
  .command('submit')
  .description('Submit a new task for the AI to plan and execute')
  .requiredOption('-g, --goal <goal>', 'The task goal / requirement')
  .requiredOption('-r, --repo <repoUrl>', 'Git repo URL to work on')
  .action(async (opts: { goal: string; repo: string }) => {
    const config = loadConfig();
    const { store, llm, notify, sandbox } = createAdapters(config);
    const orchestrator = new TaskOrchestrator(llm, store, notify, sandbox, config);

    log.info({ goal: opts.goal, repo: opts.repo }, 'Submitting task');

    await notify.start();

    try {
      const task = await orchestrator.submitAndRun(opts.goal, opts.repo);
      console.log(`\nTask ${task.id} finished with state: ${task.state}`);
      console.log(`Tokens used: ${task.tokenUsage.totalTokensIn + task.tokenUsage.totalTokensOut}`);

      if (task.featureBranch) {
        console.log(`Branch: ${task.featureBranch}`);
      }
    } finally {
      await notify.stop();
      (store as SQLiteTaskStore).close();
    }
  });

// === status ===

program
  .command('status')
  .description('Check the status of a task')
  .argument('<taskId>', 'Task ID')
  .action((taskId: string) => {
    const store = new SQLiteTaskStore(loadDbPath());

    const task = store.getTask(taskId);
    if (!task) {
      console.error(`Task not found: ${taskId}`);
      store.close();
      process.exit(1);
    }

    console.log(`Task:     ${task.id}`);
    console.log(`Goal:     ${task.goal}`);
    console.log(`State:    ${task.state}`);
    console.log(`Step:     ${task.currentStepIndex + 1}/${task.totalSteps}`);
    console.log(`Tokens:   ${task.tokenUsage.totalTokensIn + task.tokenUsage.totalTokensOut}`);
    console.log(`Branch:   ${task.featureBranch ?? 'N/A'}`);
    console.log(`Created:  ${task.createdAt}`);
    console.log(`Updated:  ${task.updatedAt}`);

    if (task.failureReason) {
      console.log(`Failure:  ${task.failureReason}`);
    }

    store.close();
  });

// === list ===

program
  .command('list')
  .description('List all tasks')
  .option('--active', 'Show only active (non-terminal) tasks')
  .action((opts: { active?: boolean }) => {
    const store = new SQLiteTaskStore(loadDbPath());

    let tasks = store.listTasks();

    if (opts.active) {
      tasks = tasks.filter((t) => !TERMINAL_STATES.has(t.state));
    }

    if (tasks.length === 0) {
      console.log('No tasks found.');
      store.close();
      return;
    }

    console.log(`${'ID'.padEnd(38)} ${'STATE'.padEnd(26)} ${'STEP'.padEnd(8)} GOAL`);
    console.log('-'.repeat(100));

    for (const task of tasks) {
      const step = `${task.currentStepIndex + 1}/${task.totalSteps}`;
      console.log(`${task.id.padEnd(38)} ${task.state.padEnd(26)} ${step.padEnd(8)} ${task.goal.slice(0, 50)}`);
    }

    store.close();
  });

// === resume ===

program
  .command('resume')
  .description('Resume a task from its current state')
  .argument('<taskId>', 'Task ID')
  .action(async (taskId: string) => {
    const config = loadConfig();
    const { store, llm, notify, sandbox } = createAdapters(config);
    const orchestrator = new TaskOrchestrator(llm, store, notify, sandbox, config);

    await notify.start();

    try {
      const task = await orchestrator.resume(taskId);
      console.log(`\nTask ${task.id} finished with state: ${task.state}`);
    } finally {
      await notify.stop();
      (store as SQLiteTaskStore).close();
    }
  });

// === Adapter factory ===

const createAdapters = (config: ReturnType<typeof loadConfig>) => {
  const store = new SQLiteTaskStore(config.dbPath);
  const llm = new ClaudeAdapter(config.anthropicApiKey);
  const notify = new TelegramAdapter(config.telegramBotToken, config.telegramChatId);
  const sandbox = new DockerSandboxRunner(config.dockerSocket, config.sandboxImage);

  return { store, llm, notify, sandbox };
};

// === Run ===

program.parseAsync(process.argv).catch((err) => {
  log.error({ error: err }, 'CLI error');
  process.exit(1);
});
