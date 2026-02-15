/**
 * Telegram notification adapter — telegraf.
 * Sends plans, step results, and failures.
 * Receives approval decisions via inline keyboard callbacks.
 */

import { Telegraf, Markup } from 'telegraf';
import type { INotificationChannel, ApprovalDecision, StepResultPayload } from '../../core/ports/notification-channel.js';
import type { Task } from '../../core/entities/task.js';
import type { Plan } from '../../core/entities/plan.js';
import { remainingBudget } from '../../core/entities/token-budget.js';
import { createLogger } from '../logger.js';

const log = createLogger('telegram');

/** Max Telegram message length. */
const MAX_MSG_LEN = 4096;

/**
 * Pending decision resolvers — keyed by taskId.
 * When the orchestrator calls waitForDecision(), it gets a promise
 * that resolves when the user taps an inline keyboard button.
 */
type DecisionResolver = (decision: ApprovalDecision) => void;

export class TelegramAdapter implements INotificationChannel {
  private bot: Telegraf;
  private chatId: string;
  private pendingDecisions = new Map<string, DecisionResolver>();

  constructor(botToken: string, chatId: string) {
    this.bot = new Telegraf(botToken);
    this.chatId = chatId;
    this.registerCallbackHandlers();
  }

  async start(): Promise<void> {
    // Use polling for v1 (simpler than webhooks for dev)
    await this.bot.launch();
    log.info('Telegram bot started (polling)');
  }

  async stop(): Promise<void> {
    this.bot.stop('SIGTERM');
    log.info('Telegram bot stopped');
  }

  async sendPlanForApproval(task: Task, plan: Plan): Promise<void> {
    const stepsPreview = plan.steps
      .map((s) => `  ${s.index + 1}. ${s.title}`)
      .join('\n');

    const msg = truncate(
      `📋 NEW PLAN\n\nTask: ${task.goal}\nID: ${task.id}\n\n${plan.summary}\n\nSteps:\n${stepsPreview}\n\nEstimated tokens: ~${plan.estimatedTokens}`,
    );

    await this.bot.telegram.sendMessage(this.chatId, msg, {
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('✅ Approve', `approve:${task.id}`),
          Markup.button.callback('❌ Reject', `reject:${task.id}`),
        ],
        [
          Markup.button.callback('🛑 Abort', `abort:${task.id}`),
        ],
      ]),
    });

    log.info({ taskId: task.id }, 'Plan sent for approval');
  }

  async sendStepResult(task: Task, result: StepResultPayload): Promise<void> {
    const { step, summary, tokensUsed, totalTokensUsed, budgetRemaining } = result;

    const msg = truncate(
      `⚡ STEP ${step.index + 1}/${task.totalSteps} COMPLETE\n\nTask: ${task.id}\nStep: ${step.title}\n\n${summary}\n\nTokens this step: ${tokensUsed}\nTotal used: ${totalTokensUsed}\nBudget remaining: ${budgetRemaining}`,
    );

    await this.bot.telegram.sendMessage(this.chatId, msg, {
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('✅ Continue', `approve:${task.id}`),
          Markup.button.callback('🛑 Abort', `abort:${task.id}`),
        ],
      ]),
    });

    log.info({ taskId: task.id, step: step.index }, 'Step result sent');
  }

  async sendFailureReport(task: Task, reason: string, stepIndex?: number): Promise<void> {
    const stepInfo = stepIndex !== undefined ? `Step ${stepIndex + 1}: ` : '';

    const msg = truncate(
      `🚨 TASK FAILED\n\nTask: ${task.id}\n${stepInfo}${reason}`,
    );

    await this.bot.telegram.sendMessage(this.chatId, msg, {
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('🔄 Retry', `retry:${task.id}`),
          Markup.button.callback('⏭ Skip Step', `skip:${task.id}`),
        ],
        [
          Markup.button.callback('🛑 Abort', `abort:${task.id}`),
        ],
      ]),
    });

    log.info({ taskId: task.id, stepIndex }, 'Failure report sent');
  }

  async sendStatus(task: Task, message: string): Promise<void> {
    await this.bot.telegram.sendMessage(
      this.chatId,
      truncate(`ℹ️ ${task.id}\n\n${message}`),
    );
  }

  async sendCompletion(task: Task, totalTokens: number, totalSteps: number): Promise<void> {
    const msg = truncate(
      `✅ TASK COMPLETED\n\nTask: ${task.id}\nGoal: ${task.goal}\nBranch: ${task.featureBranch}\nSteps: ${totalSteps}\nTotal tokens: ${totalTokens}\n\nBranch is ready for manual merge.`,
    );

    await this.bot.telegram.sendMessage(this.chatId, msg);
    log.info({ taskId: task.id }, 'Completion sent');
  }

  waitForDecision(taskId: string): Promise<ApprovalDecision> {
    return new Promise<ApprovalDecision>((resolve) => {
      this.pendingDecisions.set(taskId, resolve);
    });
  }

  // === Callback handler registration ===

  private registerCallbackHandlers(): void {
    this.bot.on('callback_query', async (ctx) => {
      const data = 'data' in ctx.callbackQuery ? ctx.callbackQuery.data : undefined;
      if (!data) return;

      const [action, taskId] = data.split(':');
      if (!action || !taskId) return;

      // Validate sender is the authorized user
      if (String(ctx.callbackQuery.from.id) !== this.chatId) {
        await ctx.answerCbQuery('Unauthorized.');
        return;
      }

      const resolver = this.pendingDecisions.get(taskId);
      if (!resolver) {
        await ctx.answerCbQuery('No pending decision for this task.');
        return;
      }

      const decision = actionToDecision(action);
      if (!decision) {
        await ctx.answerCbQuery('Unknown action.');
        return;
      }

      this.pendingDecisions.delete(taskId);
      await ctx.answerCbQuery(`${action} received.`);

      // Edit the message to show the decision was made
      try {
        await ctx.editMessageReplyMarkup(undefined);
      } catch {
        // Ignore if message can't be edited
      }

      log.info({ taskId, action }, 'Decision received');
      resolver(decision);
    });
  }
}

// === Helpers ===

const actionToDecision = (action: string): ApprovalDecision | null => {
  switch (action) {
    case 'approve': return { type: 'approve' };
    case 'reject': return { type: 'reject' };
    case 'abort': return { type: 'abort' };
    case 'retry': return { type: 'retry' };
    case 'skip': return { type: 'skip' };
    default: return null;
  }
};

const truncate = (msg: string): string =>
  msg.length > MAX_MSG_LEN ? msg.slice(0, MAX_MSG_LEN - 3) + '...' : msg;
