import { Queue, Worker, Job } from 'bullmq';
import { createBullMQConnection } from '../database/redis';
import { logger } from './logger';
import { NotificationExtra } from '../services/copyTrade';

interface NotifJobData {
  telegramId: string;
  message: string;
  extra?: NotificationExtra;
}

let _queue: Queue<NotifJobData> | null = null;
let _worker: Worker<NotifJobData> | null = null;

export function getNotificationQueue(): Queue<NotifJobData> {
  if (!_queue) {
    _queue = new Queue<NotifJobData>('notifications', {
      connection: createBullMQConnection(),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: 100,
        removeOnFail: 200,
      },
    });
  }
  return _queue;
}

/**
 * Enqueues a Telegram notification. Fire-and-forget safe.
 * The BullMQ worker (started via startNotificationWorker) drains the queue
 * at 25 msg/s — well under Telegram's 30 msg/s global limit.
 */
export async function enqueueNotification(
  telegramId: string,
  message: string,
  extra?: NotificationExtra,
): Promise<void> {
  try {
    await getNotificationQueue().add('send', { telegramId, message, extra });
  } catch (err: any) {
    logger.warn(`[notif] Failed to enqueue notification for ${telegramId}: ${err?.message}`);
  }
}

export type DirectSendFn = (
  telegramId: string,
  message: string,
  extra?: NotificationExtra,
) => Promise<void>;

/**
 * Starts the BullMQ worker that processes notification jobs.
 * Rate-limited to 25 jobs/s to stay under Telegram's 30 msg/s limit.
 * Call once at startup; the returned worker should be closed on shutdown.
 */
export function startNotificationWorker(sendFn: DirectSendFn): Worker<NotifJobData> {
  if (_worker) return _worker;

  _worker = new Worker<NotifJobData>(
    'notifications',
    async (job: Job<NotifJobData>) => {
      const { telegramId, message, extra } = job.data;
      await sendFn(telegramId, message, extra);
    },
    {
      connection: createBullMQConnection(),
      limiter: { max: 25, duration: 1000 },
      concurrency: 5,
    },
  );

  _worker.on('failed', (job, err) => {
    logger.warn(`[notif] Job ${job?.id} failed after retries: ${err?.message}`);
  });

  logger.info('[notif] Notification worker started (25 msg/s rate limit)');
  return _worker;
}

export async function closeNotificationWorker(): Promise<void> {
  if (_worker) {
    await _worker.close();
    _worker = null;
  }
  if (_queue) {
    await _queue.close();
    _queue = null;
  }
}
