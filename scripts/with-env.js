#!/usr/bin/env node
/**
 * Cross-platform replacement for `VAR=value command ...` prefixes in npm scripts.
 *
 * POSIX shells accept inline environment assignments, but PowerShell and cmd.exe do not, so
 * scripts written that way fail on Windows. This shim sets the variables and runs the command
 * without a shell, on every platform:
 *
 *   node scripts/with-env.js VAR=value [VAR2=value2 ...] -- command [args...]
 *
 * `node` as the command resolves to the running Node binary so the child uses the same runtime.
 */
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const separator = args.indexOf('--');

if (separator === -1 || separator === args.length - 1) {
  console.error('Usage: node scripts/with-env.js VAR=value [VAR2=value2 ...] -- command [args...]');
  process.exit(2);
}

const env = { ...process.env };
for (const assignment of args.slice(0, separator)) {
  const index = assignment.indexOf('=');
  if (index <= 0) {
    console.error(`Invalid environment assignment: ${assignment}`);
    process.exit(2);
  }
  env[assignment.slice(0, index)] = assignment.slice(index + 1);
}

const [command, ...commandArgs] = args.slice(separator + 1);
const executable = command === 'node' ? process.execPath : command;
const result = spawnSync(executable, commandArgs, { stdio: 'inherit', env });

if (result.error) {
  console.error(`Failed to start ${command}: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
