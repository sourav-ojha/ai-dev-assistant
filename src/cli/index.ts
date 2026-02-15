#!/usr/bin/env node

/**
 * CLI entry point — commander.
 * Commands: submit, status, list, resume
 */

import 'dotenv/config';
import * as readline from 'node:readline';
import { Command } from 'commander';
import { loadConfig, loadDbPath } from '../config/index.js';
import { SQLiteTaskStore } from '../infrastructure/persistence/sqlite-task-store.js';
import { ClaudeAdapter } from '../infrastructure/llm/claude-adapter.js';
import { TelegramAdapter } from '../infrastructure/telegram/telegram-adapter.js';
import { DockerSandboxRunner } from '../infrastructure/docker/docker-sandbox-runner.js';
import { TaskOrchestrator } from '../orchestrator/task-orchestrator.js';
import { TaskState, TERMINAL_STATES } from '../core/entities/task.js';
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
    let store: SQLiteTaskStore | null = null;
    let notify: TelegramAdapter | null = null;

    try {
      const config = loadConfig();
      const adapters = createAdapters(config);
      store = adapters.store;
      notify = adapters.notify;

      const orchestrator = new TaskOrchestrator(adapters.llm, store, notify, adapters.sandbox, config);

      log.info({ goal: opts.goal, repo: opts.repo }, 'Submitting task');
      console.log('Starting Telegram bot...');
      await notify.start();
      console.log('Telegram bot ready. Submitting task...\n');

      const task = await orchestrator.submitAndRun(opts.goal, opts.repo);
      console.log(`\nTask ${task.id} finished with state: ${task.state}`);
      console.log(`Tokens used: ${task.tokenUsage.totalTokensIn + task.tokenUsage.totalTokensOut}`);

      if (task.featureBranch) {
        console.log(`Branch: ${task.featureBranch}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ err: message }, 'Submit failed');
      console.error(`\nSubmit error: ${message}`);
      if (err instanceof Error && err.stack) {
        log.debug(err.stack);
      }
      process.exit(1);
    } finally {
      if (notify) await notify.stop().catch(() => {});
      if (store) store.close();
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

function askYesNo(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

program
  .command('resume')
  .description('Resume a task from its current state')
  .argument('<taskId>', 'Task ID')
  .action(async (taskId: string) => {
    const config = loadConfig();
    const { store, llm, notify, sandbox } = createAdapters(config);

    const existingTask = store.getTask(taskId);
    if (!existingTask) {
      console.error(`Task not found: ${taskId}`);
      store.close();
      process.exit(1);
    }

    // Task already in terminal state
    if (TERMINAL_STATES.has(existingTask.state)) {
      if (existingTask.state === TaskState.ABORTED) {
        const wantsResume = await askYesNo(`Task ${taskId} was aborted. Do you want to resume? (y/n): `);
        if (!wantsResume) {
          console.log('Exiting.');
          store.close();
          return;
        }

        // Restore task to the state before abort — from the last transition log
        const logs = store.getTransitionLogs(taskId);
        const abortLog = [...logs].reverse().find((l) => l.toState === TaskState.ABORTED);
        if (!abortLog) {
          console.error('Could not find transition log for aborted state.');
          store.close();
          process.exit(1);
        }

        const restoredTask = {
          ...existingTask,
          state: abortLog.fromState,
          failureReason: abortLog.fromState === TaskState.AWAITING_FAILURE_GUIDANCE ? existingTask.failureReason : null,
          updatedAt: new Date().toISOString(),
        };
        store.updateTask(restoredTask);
        console.log(`Restored task to ${abortLog.fromState}. Starting bot...\n`);
      } else {
        console.log(`Task ${taskId} is already ${existingTask.state}. Nothing to resume.`);
        store.close();
        return;
      }
    }

    const orchestrator = new TaskOrchestrator(llm, store, notify, sandbox, config);

    await notify.start();

    try {
      const task = await orchestrator.resume(taskId);
      console.log(`\nTask ${task.id} finished with state: ${task.state}`);
    } finally {
      await notify.stop().catch(() => {});
      store.close();
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
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;
  log.error({ err: message, stack }, 'CLI error');
  console.error(`\nError: ${message}`);
  process.exit(1);
});
