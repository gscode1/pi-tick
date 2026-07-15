// commands/transcripts.mjs — `pi-tick transcripts <id> [--limit N]`.

import { parseFlags } from "../argv.mjs";
import { fail } from "../errors.mjs";
import { validateId } from "../validate.mjs";
import { listTranscriptFiles } from "../transcript-view.mjs";
import { formatLocal } from "../format.mjs";
import { printTable } from "../display.mjs";

export function cmdTranscripts(argv, { stdout = process.stdout, stderr = process.stderr } = {}) {
  const flags = parseFlags(argv);
  const pos = flags._;
  if (pos.length < 1) fail(`transcripts requires a job id`, 2);
  const id = pos[0];
  validateId(id);
  const limit = flags.limit === undefined || flags.limit === true ? 20 : Number(flags.limit);
  if (!Number.isFinite(limit) || limit < 0) fail(`--limit must be a non-negative number (got '${flags.limit}')`, 2);

  const files = listTranscriptFiles(id)
    .sort((a, b) => b.mtime.getTime() - a.mtime.getTime())
    .slice(0, limit);

  if (files.length === 0) {
    stdout.write(`(no transcripts for job '${id}')\n`);
    return 0;
  }

  const headers = ["startedAt", "bytes", "transcript"];
  const rows = files.map((f) => [
    formatLocal(new Date(f.mtime).toISOString()),
    String(f.size),
    f.path,
  ]);
  printTable([headers, ...rows], { stdout });
  return 0;
}
