const fs = require('fs');
const path = require('path');

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_RETRY_INTERVAL_MS = 50;
const DEFAULT_STALE_MS = 30000;

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isLockStale(lockPath, staleMs) {
  try {
    const content = fs.readFileSync(lockPath, 'utf8');
    const data = JSON.parse(content);
    const pid = Number(data.pid);
    const timestamp = Number(data.timestamp);
    if (pid && !isPidAlive(pid)) return true;
    if (timestamp && Date.now() - timestamp > staleMs) return true;
    return false;
  } catch {
    // Unreadable or corrupt lock file — treat as stale.
    return true;
  }
}

function acquireLockSync(lockPath, options = {}) {
  const timeout = options.timeout != null ? options.timeout : DEFAULT_TIMEOUT_MS;
  const retryInterval = options.retryInterval != null ? options.retryInterval : DEFAULT_RETRY_INTERVAL_MS;
  const staleMs = options.staleMs != null ? options.staleMs : DEFAULT_STALE_MS;
  const deadline = Date.now() + timeout;
  const lockContent = JSON.stringify({ pid: process.pid, timestamp: Date.now() });

  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  while (true) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      fs.writeSync(fd, lockContent);
      fs.closeSync(fd);
      return;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }

    // Lock file exists — check staleness.
    if (isLockStale(lockPath, staleMs)) {
      try {
        fs.unlinkSync(lockPath);
        continue;
      } catch {
        // Another process may have already cleaned it up.
      }
    }

    if (Date.now() >= deadline) {
      throw new Error(`Failed to acquire lock: ${lockPath} (timeout ${timeout}ms)`);
    }

    // Spin-wait.
    const waitUntil = Date.now() + retryInterval;
    while (Date.now() < waitUntil) {
      // busy-wait
    }
  }
}

function releaseLockSync(lockPath) {
  try {
    fs.unlinkSync(lockPath);
  } catch {
    // Lock may already be released.
  }
}

function withFileLockSync(lockPath, fn, options = {}) {
  acquireLockSync(lockPath, options);
  try {
    return fn();
  } finally {
    releaseLockSync(lockPath);
  }
}

module.exports = { acquireLockSync, releaseLockSync, withFileLockSync };
