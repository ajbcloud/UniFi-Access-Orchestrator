/**
 * Logger - Winston singleton with daily rotation
 * 
 * Usage:
 *   const logger = require('./logger');
 *   logger.info('message');
 *   logger.configure(config);  // Optional: reconfigure with loaded config
 */

const winston = require('winston');
require('winston-daily-rotate-file');
const path = require('path');
const fs = require('fs');

const DEFAULT_LOG_DIR = process.env.LOG_DIR || '/var/log/unifi-access-orchestrator';
const DEFAULT_LEVEL = 'info';

// Ensure log directory exists
function ensureDir(dir) {
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  } catch {
    // Fall back to current directory if we can't create the log dir
  }
}

// Create the logger with defaults (works before config is loaded)
function buildLogger(logDir = DEFAULT_LOG_DIR, level = DEFAULT_LEVEL) {
  ensureDir(logDir);

  return winston.createLogger({
    level,
    transports: [
      new winston.transports.DailyRotateFile({
        filename: path.join(logDir, 'access-%DATE%.log'),
        datePattern: 'YYYY-MM-DD',
        maxFiles: '30d',
        maxSize: '10m',
        format: winston.format.combine(
          winston.format.timestamp(),
          winston.format.json()
        )
      }),
      new winston.transports.Console({
        format: winston.format.combine(
          winston.format.timestamp({ format: 'HH:mm:ss' }),
          winston.format.printf(({ timestamp, level, message }) => {
            return `${timestamp} [${level.toUpperCase()}] ${message}`;
          })
        )
      })
    ]
  });
}

const logger = buildLogger();

// Allow reconfiguration after config is loaded
logger.configure_from_config = function(config) {
  const logConfig = config.logging || {};
  const logDir = logConfig.file_path
    ? path.dirname(logConfig.file_path)
    : DEFAULT_LOG_DIR;
  const level = logConfig.level || DEFAULT_LEVEL;

  this.level = level;
  this.transports.forEach(t => { t.level = level; });
  ensureDir(logDir);
};

module.exports = logger;
