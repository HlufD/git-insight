import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { GitCancelledError, GitCommandError, GitNotFoundError, NotARepositoryError } from './errors';

export interface GitRunOptions {
  signal?: AbortSignal;
}

export interface GitInvocation {
  args: readonly string[];
  durationMs: number;
  exitCode: number | null;
}

export interface GitRunnerOptions {
  /** Executable to run; defaults to `git` on PATH. */
  gitPath?: string;
  /** Arguments placed before every subcommand. Tests override this to run fake executables. */
  globalArgs?: readonly string[];
  /** Called after every invocation (for logging and tests). */
  onInvocation?: (invocation: GitInvocation) => void;
}

/** Options that keep output stable and machine-readable whatever the user's git config says. */
export const DEFAULT_GLOBAL_ARGS: readonly string[] = [
  '-c', 'core.quotepath=off',
  '-c', 'color.ui=false',
  '-c', 'log.showSignature=false',
  '-c', 'i18n.logOutputEncoding=UTF-8',
];

const KILL_GRACE_MS = 500;
const STDERR_LIMIT = 64 * 1024;

/**
 * The only way the extension talks to git. Uses `spawn` with an argument array
 * (never a shell), streams stdout line by line, and kills the process on abort.
 */
export class GitRunner {
  readonly gitPath: string;
  private readonly globalArgs: readonly string[];
  private readonly onInvocation?: (invocation: GitInvocation) => void;

  constructor(readonly cwd: string, options: GitRunnerOptions = {}) {
    this.gitPath = options.gitPath || 'git';
    this.globalArgs = options.globalArgs ?? DEFAULT_GLOBAL_ARGS;
    this.onInvocation = options.onInvocation;
  }

  /** Runs git and returns all of stdout. Only for commands with small output. */
  async run(args: readonly string[], options: GitRunOptions = {}): Promise<string> {
    const lines: string[] = [];
    await this.streamLines(args, (line) => lines.push(line), options);
    return lines.join('\n');
  }

  /** Runs git and calls `onLine` for every stdout line, without buffering the whole output. */
  streamLines(args: readonly string[], onLine: (line: string) => void, options: GitRunOptions = {}): Promise<void> {
    const { signal } = options;
    if (signal?.aborted) return Promise.reject(new GitCancelledError());

    const started = Date.now();
    return new Promise<void>((resolve, reject) => {
      const child = spawn(this.gitPath, [...this.globalArgs, ...args], {
        cwd: this.cwd,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C', LANGUAGE: '' },
      });

      let settled = false;
      let cancelled = false;
      let callbackError: unknown;
      let stderr = '';
      let killTimer: NodeJS.Timeout | undefined;

      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        if (killTimer) clearTimeout(killTimer);
        if (error) reject(error);
        else resolve();
      };

      const kill = () => {
        child.kill('SIGTERM');
        killTimer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
        killTimer.unref();
      };

      const onAbort = () => {
        cancelled = true;
        kill();
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        if (stderr.length < STDERR_LIMIT) stderr += chunk;
      });

      child.stdout.setEncoding('utf8');
      const reader = createInterface({ input: child.stdout, crlfDelay: Infinity });
      reader.on('line', (line) => {
        if (cancelled || callbackError) return;
        try {
          onLine(line);
        } catch (error) {
          callbackError = error;
          kill();
        }
      });

      child.on('error', (error: NodeJS.ErrnoException) => {
        finish(error.code === 'ENOENT' ? new GitNotFoundError(this.gitPath) : error);
      });

      // 'close' fires after stdout has been fully read, so every line has been delivered.
      child.on('close', (exitCode) => {
        this.onInvocation?.({ args, durationMs: Date.now() - started, exitCode });
        if (callbackError) return finish(callbackError);
        if (cancelled) return finish(new GitCancelledError());
        if (exitCode !== 0) {
          if (/not a git repository/i.test(stderr)) return finish(new NotARepositoryError(this.cwd));
          return finish(new GitCommandError(args, exitCode, stderr));
        }
        finish();
      });
    });
  }
}
