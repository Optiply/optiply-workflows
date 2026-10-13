/**
 * CLI arguments for `parseArgs`. pnpm 10 forwards the `--` in `pnpm <script> -- --flag` literally, and parseArgs
 * treats everything after `--` as positionals, so a leading `--` is dropped.
 */
export function cliArgs(): string[] {
  const args = process.argv.slice(2)
  return args[0] === '--' ? args.slice(1) : args
}
