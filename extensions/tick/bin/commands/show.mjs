// commands/show.mjs — `pi-tick show <id> [--run N|--run-id <id>] [--tail M] [--raw] [--no-meta]`.

import { readFileSync } from "node:fs";
import { parseFlags } from "../argv.mjs";
import { fail } from "../errors.mjs";
import { validateId } from "../validate.mjs";
import {
  listTranscriptFiles, parseTranscriptFilename, findRunRecord,
  formatRunHeader, prettyPrintTranscript,
} from "../transcript-view.mjs";

export function cmdShow(argv, { stdout = process.stdout, stderr = process.stderr } = {}) {
  const flags = parseFlags(argv);
  const pos = flags._;
  if (pos.length < 1) fail(`show requires a job id`, 2);
  const id = pos[0];
  validateId(id);
  const runId = flags["run-id"] === undefined || flags["run-id"] === true ? null : String(flags["run-id"]);
  const runIdx = flags.run === undefined || flags.run === true ? 0 : Number(flags.run);
  if (runId && flags.run !== undefined) fail(`use either --run or --run-id, not both`, 2);
  if (!Number.isInteger(runIdx) || runIdx < 0) fail(`--run must be a non-negative integer (got '${flags.run}')`, 2);
  let tailTurns = null;
  if (flags.tail !== undefined) {
    tailTurns = flags.tail === true ? 0 : Number(flags.tail);
    if (!Number.isInteger(tailTurns) || tailTurns < 0) {
      fail(`--tail must be a non-negative integer (got '${flags.tail}')`, 2);
    }
  }
  const rawMode = flags.raw === true || flags.raw === "true";
  const noMeta = flags["no-meta"] === true || flags["no-meta"] === "true";

  const files = listTranscriptFiles(id).sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  if (files.length === 0) {
    stdout.write(`(no transcripts for job '${id}')\n`);
    return 0;
  }
  let file = files[runIdx];
  if (runId) {
    file = files.find((f) => {
      const parsed = parseTranscriptFilename(f.name);
      return parsed && parsed.runId === runId;
    });
    if (!file) fail(`no transcript for job '${id}' with runId '${runId}'`, 4);
  } else if (runIdx >= files.length) {
    fail(`--run ${runIdx} is out of range; only ${files.length} transcript(s) available for '${id}'`, 2);
  }
  const content = readFileSync(file.path, "utf8");

  if (rawMode) {
    // Emit one event per line for easy piping to `jq`. We tag with `event:`
    // so the user can grep on the prefix. Malformed lines are passed through
    // verbatim with a `raw:` tag so they aren't silently lost.
    for (const line of content.split("\n")) {
      if (!line) continue;
      try {
        const evt = JSON.parse(line);
        stdout.write(`event: ${JSON.stringify(evt)}\n`);
      } catch {
        stdout.write(`raw: ${line}\n`);
      }
    }
    return 0;
  }

  const events = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); } catch { /* skip non-JSON */ }
  }

  if (!noMeta) {
    const parsed = parseTranscriptFilename(file.name);
    const rec = parsed ? findRunRecord(parsed.runId) : null;
    stdout.write(formatRunHeader(file, rec, id) + "\n");
  }

  // Optionally trim to the last N assistant turns. A "turn" is one
  // assistant `message_end`. We keep everything from the Nth-to-last turn
  // onwards (including the user prompt that precedes it, if any).
  let viewEvents = events;
  if (tailTurns !== null && tailTurns > 0) {
    const turnIdxs = [];
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      if (e && e.type === "message_end" && e.message && e.message.role === "assistant") {
        turnIdxs.push(i);
      }
    }
    if (turnIdxs.length > tailTurns) {
      const start = turnIdxs[turnIdxs.length - tailTurns];
      // Walk back to include the user prompt that triggered this turn, if
      // it lives within a few events.
      let userStart = start;
      for (let j = start - 1; j >= Math.max(0, start - 4); j--) {
        const e = events[j];
        if (e && e.type === "message_end" && e.message && e.message.role === "user") {
          userStart = j;
          break;
        }
      }
      viewEvents = events.slice(userStart);
    }
  }

  const body = prettyPrintTranscript(viewEvents);
  if (body.length === 0) {
    stdout.write("(no renderable content in this transcript)\n");
  } else {
    stdout.write(body);
    if (!body.endsWith("\n")) stdout.write("\n");
  }
  return 0;
}
