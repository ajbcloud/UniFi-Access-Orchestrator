const fs = require('fs');
const path = require('path');

const BACKUP_PREFIX = 'config_';
const BACKUP_EXT = '.json';
const BACKUP_PATTERN = /^config_\d{4}-\d{2}-\d{2}_\d{6}\.json$/;

function ensureBackupDir(backupDir) {
  fs.mkdirSync(backupDir, { recursive: true });
  // Backups contain config secrets, so keep the directory owner-only.
  try { fs.chmodSync(backupDir, 0o700); } catch (e) { /* best effort on non-POSIX */ }
}

function formatTimestamp(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function createBackup(configPath, backupDir) {
  ensureBackupDir(backupDir);

  if (!fs.existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}`);
  }

  const timestamp = formatTimestamp(new Date());
  const filename = `${BACKUP_PREFIX}${timestamp}${BACKUP_EXT}`;
  const destPath = path.join(backupDir, filename);

  fs.copyFileSync(configPath, destPath);
  // The backup carries config secrets; restrict it to the owner.
  try { fs.chmodSync(destPath, 0o600); } catch (e) { /* best effort on non-POSIX */ }

  const stat = fs.statSync(destPath);
  return {
    filename,
    path: destPath,
    timestamp: new Date().toISOString(),
    size: stat.size
  };
}

function listBackups(backupDir) {
  ensureBackupDir(backupDir);

  const files = fs.readdirSync(backupDir).filter(f => BACKUP_PATTERN.test(f));

  const backups = files.map(filename => {
    const filePath = path.join(backupDir, filename);
    const stat = fs.statSync(filePath);
    const match = filename.match(/config_(\d{4})-(\d{2})-(\d{2})_(\d{2})(\d{2})(\d{2})\.json/);
    let timestamp = stat.mtime.toISOString();
    if (match) {
      const [, y, mo, d, h, mi, s] = match;
      timestamp = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}`).toISOString();
    }

    return {
      filename,
      timestamp,
      size: stat.size,
      sizeFormatted: formatBytes(stat.size)
    };
  });

  backups.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return backups;
}

function restoreBackup(backupFilename, backupDir, configPath) {
  if (!BACKUP_PATTERN.test(backupFilename)) {
    throw new Error(`Invalid backup filename: ${backupFilename}`);
  }

  const backupPath = path.join(backupDir, backupFilename);
  if (!fs.existsSync(backupPath)) {
    throw new Error(`Backup file not found: ${backupFilename}`);
  }

  const content = fs.readFileSync(backupPath, 'utf-8');
  try {
    JSON.parse(content);
  } catch (e) {
    throw new Error(`Backup file is not valid JSON: ${backupFilename}`);
  }

  createBackup(configPath, backupDir);

  fs.copyFileSync(backupPath, configPath);
  // Keep the live config owner-only after a restore.
  try { fs.chmodSync(configPath, 0o600); } catch (e) { /* best effort on non-POSIX */ }

  return {
    restored: backupFilename,
    preRestoreBackup: true
  };
}

function pruneBackups(backupDir, maxCount = 12) {
  const backups = listBackups(backupDir);
  const removed = [];

  if (backups.length > maxCount) {
    const toRemove = backups.slice(maxCount);
    for (const backup of toRemove) {
      const filePath = path.join(backupDir, backup.filename);
      try {
        fs.unlinkSync(filePath);
        removed.push(backup.filename);
      } catch (e) {
        // ignore removal errors
      }
    }
  }

  return { kept: Math.min(backups.length, maxCount), removed };
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

module.exports = { createBackup, listBackups, restoreBackup, pruneBackups };
