/** Base class so callers can tell our errors from unexpected ones. */
export class GitInsightError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class GitNotFoundError extends GitInsightError {
  constructor(readonly gitPath: string) {
    super(`Git not found (tried "${gitPath}"). Install Git or set gitInsight.gitPath.`);
  }
}

export class NotARepositoryError extends GitInsightError {
  constructor(readonly folder: string) {
    super(`"${folder}" is not inside a Git repository.`);
  }
}

export class EmptyRepositoryError extends GitInsightError {
  constructor(readonly repoRoot: string) {
    super('This repository has no commits yet.');
  }
}

export class GitCancelledError extends GitInsightError {
  constructor() {
    super('The Git operation was cancelled.');
  }
}

export class GitCommandError extends GitInsightError {
  constructor(
    readonly args: readonly string[],
    readonly exitCode: number | null,
    readonly stderr: string,
  ) {
    super(`git ${args[0] ?? ''} failed (exit ${exitCode ?? 'signal'}): ${firstLine(stderr) || 'no error output'}`);
  }
}

function firstLine(text: string): string {
  return text.trim().split(/\r?\n/, 1)[0] ?? '';
}
