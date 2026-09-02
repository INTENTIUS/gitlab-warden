/**
 * CLI error carrying its process exit code. Shared by the subcommand argument
 * parsers so `cli.ts` can map bad input to the documented exit codes.
 */
export class CliError extends Error {
  constructor(
    public readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = "CliError";
  }
}
