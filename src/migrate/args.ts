/**
 * Argument parsing for `gitlab-warden migrate`.
 *
 * Pure — throws `CliError` (exit 2) on bad input, like `parseReconcileArgs`.
 *
 * Shape:
 *   gitlab-warden migrate <path> [flags]
 *     <path>                 one workflow file, or a directory (typically .github/workflows/)
 *     -o, --output <path>    output file (single input) or directory (directory input)
 *     --emit yaml|ts         output format (default yaml)
 *     --strict               exit 1 on any error-severity diagnostic
 *     --report <file>        write SARIF v2.1.0 findings
 *     --use-composites       rewrite eligible jobs to chant composites
 *     --stitch/--no-stitch   directory mode: emit a root .gitlab-ci.yml (default on)
 */

import { CliError } from "../cli-error.js";

export interface MigrateArgs {
  /** Workflow file or directory to migrate. */
  input: string;
  /** Output file (single input) or directory (directory input). Default: stdout / "./". */
  output: string | undefined;
  emit: "yaml" | "ts";
  strict: boolean;
  /** SARIF report path, when requested. */
  report: string | undefined;
  useComposites: boolean;
  /** Directory mode: emit a root `.gitlab-ci.yml` of `include: local:` entries. */
  stitch: boolean;
}

const KNOWN_FLAGS = new Set([
  "-o",
  "--output",
  "--emit",
  "--strict",
  "--report",
  "--use-composites",
  "--stitch",
  "--no-stitch",
]);

/** Parse migrate argv (everything after the `migrate` subcommand). */
export function parseMigrateArgs(argv: string[]): MigrateArgs {
  const args: MigrateArgs = {
    input: "",
    output: undefined,
    emit: "yaml",
    strict: false,
    report: undefined,
    useComposites: false,
    stitch: true,
  };

  const need = (i: number, flag: string): string => {
    const v = argv[i];
    if (v === undefined || v.startsWith("-")) throw new CliError(2, `${flag} requires a value`);
    return v;
  };

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (!arg.startsWith("-")) {
      if (args.input) throw new CliError(2, `unexpected extra positional argument: ${arg}`);
      args.input = arg;
      i++;
      continue;
    }
    if (!KNOWN_FLAGS.has(arg)) throw new CliError(2, `unknown flag: ${arg}`);
    switch (arg) {
      case "-o":
      case "--output":
        args.output = need(++i, arg);
        break;
      case "--emit": {
        const v = argv[++i];
        if (v !== "yaml" && v !== "ts") throw new CliError(2, `--emit must be "yaml" or "ts", got: ${v ?? "(missing)"}`);
        args.emit = v;
        break;
      }
      case "--strict":
        args.strict = true;
        break;
      case "--report":
        args.report = need(++i, arg);
        break;
      case "--use-composites":
        args.useComposites = true;
        break;
      case "--stitch":
        args.stitch = true;
        break;
      case "--no-stitch":
        args.stitch = false;
        break;
    }
    i++;
  }

  if (!args.input) throw new CliError(2, "migrate requires a workflow file or directory path");
  return args;
}
