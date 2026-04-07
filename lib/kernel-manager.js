const crypto = require('crypto');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');

const DEFAULT_EXECUTE_TIMEOUT_MS = 300000;
const KILL_ESCALATION_MS = 3000;
const MAX_STDERR_CHUNKS = 100;

class PythonNotebookKernel {
  constructor({ configDir, taskId, language = 'python', spawnImpl = spawn, executeTimeoutMs = DEFAULT_EXECUTE_TIMEOUT_MS }) {
    this.configDir = configDir;
    this.taskId = String(taskId || '');
    this.language = language;
    this.spawnImpl = spawnImpl;
    this.executeTimeoutMs = executeTimeoutMs;
    this.child = null;
    this.rl = null;
    this.pending = new Map();
    this.queue = Promise.resolve();
    this.exited = false;
    this.status = 'cold';
    this.currentRequestId = '';
    this.stderrChunks = [];
    this._onStream = null;
    this.restartCount = 0;
  }

  async execute(code, onStream = null) {
    const task = this.queue.then(() => this._execute(code, onStream));
    this.queue = task.catch(() => {});
    return task;
  }

  async _execute(code, onStream = null) {
    await this.ensureStarted();
    const requestId = crypto.randomUUID();
    const payload = JSON.stringify({
      id: requestId,
      type: 'execute',
      code_b64: Buffer.from(String(code || ''), 'utf8').toString('base64'),
    });
    this.status = 'busy';
    this.currentRequestId = requestId;
    this.stderrChunks = [];
    this._onStream = onStream;

    try {
      const response = await new Promise((resolve, reject) => {
        let timer = null;
        if (this.executeTimeoutMs > 0) {
          timer = setTimeout(() => {
            this.pending.delete(requestId);
            reject(new Error(`Kernel execution timed out after ${this.executeTimeoutMs}ms`));
            this._escalateKill();
          }, this.executeTimeoutMs);
        }
        this.pending.set(requestId, {
          resolve: (val) => { if (timer) clearTimeout(timer); resolve(val); },
          reject: (err) => { if (timer) clearTimeout(timer); reject(err); },
        });
        try {
          this.child.stdin.write(payload + '\n', 'utf8');
        } catch (error) {
          if (timer) clearTimeout(timer);
          this.pending.delete(requestId);
          reject(error);
        }
      });

      // Attach any captured stderr to the response
      if (this.stderrChunks.length > 0) {
        const captured = Buffer.concat(this.stderrChunks).toString('utf8');
        if (captured) {
          response.stderr = ((response.stderr || '') + captured).trim();
        }
      }
      this.stderrChunks = [];

      return response;
    } finally {
      if (this.currentRequestId === requestId) {
        this.currentRequestId = '';
      }
      this._onStream = null;
      if (this.child && !this.exited) {
        this.status = 'idle';
      }
    }
  }

  _escalateKill() {
    if (!this.child || this.exited) return;
    try { this.child.kill('SIGINT'); } catch {}
    setTimeout(() => {
      if (!this.child || this.exited) return;
      try { this.child.kill('SIGKILL'); } catch {}
    }, KILL_ESCALATION_MS);
  }

  async ensureStarted() {
    if (this.child && !this.exited) return;
    this.status = 'starting';

    const workerPath = path.join(__dirname, 'python-kernel-worker.py');
    const child = this.spawnImpl('python3', ['-u', workerPath], {
      cwd: this.configDir,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.child = child;
    this.exited = false;
    this.status = 'idle';
    this.restartCount++;

    this.stderrChunks = [];
    child.stderr.on('data', (chunk) => {
      this.stderrChunks.push(chunk);
      if (this.stderrChunks.length > MAX_STDERR_CHUNKS) {
        this.stderrChunks = this.stderrChunks.slice(-MAX_STDERR_CHUNKS);
      }
    });

    this.rl = readline.createInterface({ input: child.stdout });
    this.rl.on('line', (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }

      // Stream message - forward to callback
      if (message.type === 'stream') {
        const requestId = String(message.id || '');
        if (this._onStream && this.currentRequestId === requestId) {
          this._onStream(message.text || '');
        }
        return;
      }

      // Final response message
      const requestId = String(message.id || '');
      const pending = this.pending.get(requestId);
      if (!pending) return;
      this.pending.delete(requestId);
      pending.resolve(message);
    });

    child.on('error', (error) => {
      this.status = 'dead';
      this._rejectPending(error);
    });

    child.on('exit', (code, signal) => {
      this.exited = true;
      this.status = 'dead';
      this.child = null;
      if (this.rl) {
        this.rl.close();
        this.rl = null;
      }
      const suffix = signal ? `signal ${signal}` : `code ${code}`;
      this._rejectPending(new Error(`Python notebook kernel exited with ${suffix}`));
    });
  }

  _rejectPending(error) {
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const item of pending) {
      try {
        item.reject(error);
      } catch {}
    }
  }

  dispose() {
    const child = this.child;
    this.child = null;
    this.exited = true;
    this.status = 'dead';
    this.currentRequestId = '';
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
    this._rejectPending(new Error('Python notebook kernel disposed'));
    if (!child) return;
    try {
      child.kill('SIGTERM');
    } catch {}
  }

  getStatus() {
    return {
      language: this.language,
      taskId: this.taskId,
      started: !!this.child && !this.exited,
      state: this.status,
      pendingCount: this.pending.size,
      currentRequestId: this.currentRequestId,
      restartCount: this.restartCount,
    };
  }

  async interrupt() {
    if (!this.child || this.exited) {
      return {
        ok: true,
        interrupted: false,
        message: 'Kernel is not running.',
        status: this.getStatus(),
      };
    }
    if (this.status !== 'busy') {
      return {
        ok: true,
        interrupted: false,
        message: 'Kernel is idle.',
        status: this.getStatus(),
      };
    }
    try {
      this.child.kill('SIGINT');
      return {
        ok: true,
        interrupted: true,
        message: 'Interrupt signal sent.',
        status: this.getStatus(),
      };
    } catch (error) {
      return {
        ok: false,
        interrupted: false,
        message: error.message,
        status: this.getStatus(),
      };
    }
  }
}

class NotebookKernelManager {
  constructor() {
    this.runtimes = new Map();
  }

  buildKey({ language, configDir, taskId }) {
    return JSON.stringify({
      language: String(language || ''),
      configDir: String(configDir || ''),
      taskId: String(taskId || ''),
    });
  }

  getOrCreateRuntime({ language, configDir, taskId, executeTimeoutMs }) {
    const key = this.buildKey({ language, configDir, taskId });
    if (this.runtimes.has(key)) return this.runtimes.get(key);

    if (language !== 'python') {
      throw new Error(`Notebook kernel not implemented for language: ${language}`);
    }

    const opts = { configDir, taskId, language };
    if (executeTimeoutMs != null) opts.executeTimeoutMs = executeTimeoutMs;
    const runtime = new PythonNotebookKernel(opts);
    this.runtimes.set(key, runtime);
    return runtime;
  }

  async execute(request) {
    const runtime = this.getOrCreateRuntime(request);
    try {
      return await runtime.execute(request.code, request.onStream || null);
    } catch (error) {
      // If the kernel died, dispose and let next call create a fresh one
      if (runtime.exited || runtime.status === 'dead') {
        const key = this.buildKey(request);
        this.runtimes.delete(key);
        runtime.dispose();
      }
      throw error;
    }
  }

  getStatus(request) {
    const normalized = {
      language: String(request.language || ''),
      configDir: String(request.configDir || ''),
      taskId: String(request.taskId || ''),
    };
    const key = this.buildKey(normalized);
    const runtime = this.runtimes.get(key);
    if (!runtime) {
      return {
        language: normalized.language,
        taskId: normalized.taskId,
        started: false,
        state: 'cold',
        pendingCount: 0,
        currentRequestId: '',
      };
    }
    return runtime.getStatus();
  }

  async interrupt(request) {
    const key = this.buildKey(request);
    const runtime = this.runtimes.get(key);
    if (!runtime) {
      return {
        ok: true,
        interrupted: false,
        message: 'Kernel is not running.',
        status: this.getStatus(request),
      };
    }
    return runtime.interrupt();
  }

  async restart(request) {
    this.disposeRuntime(request);
    const runtime = this.getOrCreateRuntime(request);
    await runtime.ensureStarted();
    return {
      ok: true,
      restarted: true,
      message: 'Kernel restarted.',
      status: runtime.getStatus(),
    };
  }

  disposeRuntime(request) {
    const key = this.buildKey(request);
    const runtime = this.runtimes.get(key);
    if (!runtime) return;
    this.runtimes.delete(key);
    runtime.dispose();
  }

  disposeRuntimesForConfigDir(configDir) {
    for (const [key, runtime] of this.runtimes.entries()) {
      if (runtime.configDir !== configDir) continue;
      this.runtimes.delete(key);
      runtime.dispose();
    }
  }

  disposeAll() {
    for (const runtime of this.runtimes.values()) {
      runtime.dispose();
    }
    this.runtimes.clear();
  }
}

const globalKernelManager = new NotebookKernelManager();

let cleanupHooksInstalled = false;
function installKernelCleanupHooks() {
  if (cleanupHooksInstalled) return;
  cleanupHooksInstalled = true;
  process.once('exit', () => globalKernelManager.disposeAll());
}

installKernelCleanupHooks();

module.exports = {
  NotebookKernelManager,
  getNotebookKernelManager() {
    return globalKernelManager;
  },
  disposeNotebookRuntimesForConfigDir(configDir) {
    globalKernelManager.disposeRuntimesForConfigDir(configDir);
  },
  disposeAllNotebookRuntimes() {
    globalKernelManager.disposeAll();
  },
};
