import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { PassThrough, type Readable } from 'node:stream';
import { GitCancelledError, GitCommandError, GitInsightError, GitNotFoundError, NotARepositoryError } from './errors';

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
const DEFAULT_MAX_BUFFER = 50 * 1024 * 1024;

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
    return this.execute(args, options, (stdout, fail) => {
      stdout.setEncoding('utf8');
      const reader = createInterface({ input: stdout, crlfDelay: Infinity });
      reader.on('line', (line) => {
        try {
          onLine(line);
        } catch (error) {
          fail(error);
        }
      });
    });
  }

  /**
   * Runs git and returns stdout as raw bytes (file contents keep CRLF, trailing
   * newlines and encoding). Fails instead of buffering more than `maxBytes`.
   */
  async runBuffer(args: readonly string[], options: GitRunOptions & { maxBytes?: number } = {}): Promise<Buffer> {
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BUFFER;
    const chunks: Buffer[] = [];
    let size = 0;
    await this.execute(args, options, (stdout, fail) => {
      stdout.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) fail(new GitInsightError(`git ${args[0] ?? ''} output is larger than ${Math.round(maxBytes / 1_048_576)} MB.`));
        else chunks.push(chunk);
      });
    });
    return Buffer.concat(chunks);
  }

  private execute(
    args: readonly string[],
    options: GitRunOptions,
    consume: (stdout: Readable, fail: (error: unknown) => void) => void,
  ): Promise<void> {
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
      let consumerError: unknown;
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

      // Output after a cancel or a consumer error is dropped.
      const gated = new PassThrough();
      child.stdout.on('data', (chunk: Buffer) => {
        if (!cancelled && consumerError === undefined) gated.write(chunk);
      });
      child.stdout.on('end', () => gated.end());
      consume(gated, (error) => {
        if (consumerError !== undefined) return;
        consumerError = error;
        kill();
      });

      child.on('error', (error: NodeJS.ErrnoException) => {
        finish(error.code === 'ENOENT' ? new GitNotFoundError(this.gitPath) : error);
      });

      // Wait for the consumer to see all output before settling.
      child.on('close', (exitCode) => {
        let reported = false;
        const settle = () => {
          if (reported) return;
          reported = true;
          this.onInvocation?.({ args, durationMs: Date.now() - started, exitCode });
          if (consumerError !== undefined) return finish(consumerError);
          if (cancelled) return finish(new GitCancelledError());
          if (exitCode !== 0) {
            if (/not a git repository/i.test(stderr)) return finish(new NotARepositoryError(this.cwd));
            return finish(new GitCommandError(args, exitCode, stderr));
          }
          finish();
        };
        if (gated.readableEnded || gated.destroyed) settle();
        else gated.once('end', settle).once('close', settle);
      });
    });
  }
}
