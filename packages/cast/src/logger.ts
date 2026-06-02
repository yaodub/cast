import pino from 'pino';

const isProd = process.env.NODE_ENV === 'production' || !!process.env.PM2_HOME;

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  ...(isProd ? {} : { transport: { target: 'pino-pretty', options: { colorize: true, singleLine: true } } }),
});

// SIDE EFFECT: Route uncaught errors through pino so they get timestamps in stderr
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'Unhandled rejection');
  // No process.exit — let Node's default --unhandled-rejections=throw
  // promote these to uncaughtException if the handler is ever removed.
  // Logger should observe, not kill.
});
