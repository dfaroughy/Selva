const crypto = require('crypto');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');

class PythonNotebookKernel {
  constructor({ configDir, trailId, language = 'python', spawnImpl = spawn }) {
    this.configDir = configDir;
    this.trailId = String(trailId || '');
    this.language = language;
    this.spawnImpl = spawnImpl;
    this.child = null;
    this.rl = null;
    this.pending = new Map();
    this.queue = Promise.resolve();
    this.exited = false;
  }

  async execute(code) {
    const task = this.queue.then(() => this._execute(code));
    this.queue = task.catch(() => {});
    return task;
  }

  async _execute(code) {
    await this.ensureStarted();
    const requestId = crypto.randomUUID();
    const payload = JSON.stringify({
      id: requestId,
      type: 'execute',
      code_b64: Buffer.from(String(code || ''), 'utf8').toString('base64'),
    });

    const response = await new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      try {
        this.child.stdin.write(payload + '\n', 'utf8');
      } catch (error) {
        this.pending.delete(requestId);
        reject(error);
      }
    });

    return response;
  }

  async ensureStarted() {
    if (this.child && !this.exited) return;

    const workerPath = path.join(__dirname, 'python-kernel-worker.py');
    const child = this.spawnImpl('python3', ['-u', workerPath], {
      cwd: this.configDir,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.child = child;
    this.exited = false;

    this.rl = readline.createInterface({ input: child.stdout });
    this.rl.on('line', (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      const requestId = String(message.id || '');
      const pending = this.pending.get(requestId);
      if (!pending) return;
      this.pending.delete(requestId);
      pending.resolve(message);
    });

    child.on('error', (error) => {
      this._rejectPending(error);
    });

    child.on('exit', (code, signal) => {
      this.exited = true;
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
}

class NotebookKernelManager {
  constructor() {
    this.runtimes = new Map();
  }

  buildKey({ language, configDir, trailId }) {
    return JSON.stringify({
      language: String(language || ''),
      configDir: String(configDir || ''),
      trailId: String(trailId || ''),
    });
  }

  getOrCreateRuntime({ language, configDir, trailId }) {
    const key = this.buildKey({ language, configDir, trailId });
    if (this.runtimes.has(key)) return this.runtimes.get(key);

    if (language !== 'python') {
      throw new Error(`Notebook kernel not implemented for language: ${language}`);
    }

    const runtime = new PythonNotebookKernel({ configDir, trailId, language });
    this.runtimes.set(key, runtime);
    return runtime;
  }

  async execute(request) {
    const runtime = this.getOrCreateRuntime(request);
    try {
      return await runtime.execute(request.code);
    } catch (error) {
      const key = this.buildKey(request);
      this.runtimes.delete(key);
      throw error;
    }
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
