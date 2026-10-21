import { loadConfig, loadEnvironment, ConfigError } from './config.js';
import { JarvisBot } from './discord/bot.js';
import { Logger } from './observability/metrics.js';

loadEnvironment();
let bot: JarvisBot | undefined;
let logger = new Logger();
let stopping = false;
async function stop(failed = false): Promise<void> {
  if (stopping) return;
  stopping = true;
  process.exitCode = failed ? 1 : 0;
  const deadline = setTimeout(() => process.exit(failed ? 1 : 0), 8_000);
  deadline.unref();
  await bot?.stop();
}
process.once('SIGINT', () => { void stop(); });
process.once('SIGTERM', () => { void stop(); });
process.on('unhandledRejection', () => { logger.event('unhandled_rejection', 'error'); void stop(true); });
process.on('uncaughtException', () => { logger.event('uncaught_exception', 'error'); void stop(true); });

try {
  const config = loadConfig(undefined, process.argv.includes('--dave-smoke'));
  logger = new Logger(config.JARVIS_LOG_LEVEL);
  bot = new JarvisBot(config, logger);
  await bot.start();
} catch (error) {
  if (error instanceof ConfigError) process.stdout.write(`${error.message}\n`);
  logger.event('startup_failed', 'error');
  await stop(true);
}
