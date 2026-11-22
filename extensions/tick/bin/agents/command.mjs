// agents/command.mjs — the `command` adapter: run the job's prompt as a
// /bin/sh command line, with no model. The exit code decides success; the
// last non-empty stdout line becomes the run's final text (finalTextPreview)
// and the fallback error text, so a script can print a one-line summary.
// stdout and stderr go to the transcript verbatim.
//
// CLI-only (`pi-tick add --agent command`): the tick_create tool does not
// expose an agent choice, so a model can never schedule a shell command.
export const COMMAND_SHELL = "/bin/sh";

export function buildRunArgs(job) {
  return { args: ["-c", String(job.prompt)], effectiveModel: null, isSlashCommand: false };
}

export function createLifecycle() {
  let last = null;
  return {
    writePrompt() {},
    clear() {},
    handleLine(line) {
      const t = String(line).trim();
      if (t) last = t.slice(0, 2000);
    },
    getFinalText: () => last,
    getLastUsage: () => null,
    getFinalError: () => null,
  };
}
