// scripts/dump-input-cost.mjs
//
// Diagnoses where the input tokens for a one-shot `pi -p "hello world"` go.
// Reads the actual prompt components (system + built-in tools + extension
// tools) and tokenizes them with cl100k_base (Anthropic's tokenizer for
// Claude 3+).
//
// Run:  node scripts/dump-input-cost.mjs

import { pathToFileURL } from "node:url";
import { readFile } from "node:fs/promises";
import { encodingForModel } from "js-tiktoken";

const PI_DIST = "/Users/gs/.local/share/mise/installs/node/latest/lib/node_modules/@earendil-works/pi-coding-agent/dist";
const CTX_BUNDLE = "/Users/gs/.pi/agent/npm/node_modules/context-mode/server.bundle.mjs";
const TICK_EXT = "/Users/gs/Dev/coding/pi-tick/extensions/tick/index.ts";

const { buildSystemPrompt } = await import(pathToFileURL(`${PI_DIST}/core/system-prompt.js`).href);

const enc = encodingForModel("gpt-4");
const tok = (s) => enc.encode(s || "").length;

console.log("═══════════════════════════════════════════════════════════════════");
console.log("  PI INPUT-COST BREAKDOWN  (real cl100k_base token counts)");
console.log("═══════════════════════════════════════════════════════════════════\n");

// ─── 1. Built-in tools ────────────────────────────────────────────────
const TOOL_DIR = `${PI_DIST}/core/tools`;
const builtinToolNames = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const toolSnippets = {};
const toolDefs = [];
for (const name of builtinToolNames) {
  try {
    const mod = await import(pathToFileURL(`${TOOL_DIR}/${name}.js`).href);
    const cap = name[0].toUpperCase() + name.slice(1);
    const fn = mod[`create${cap}ToolDefinition`] || mod[`create${name}ToolDefinition`];
    if (!fn) continue;
    const def = fn("/tmp", {});
    toolSnippets[name] = def.promptSnippet;
    toolDefs.push({ name, def });
  } catch (e) {
    console.error(`  skip ${name}: ${e.message}`);
  }
}

// ─── 2. Extract ctx_* tool definitions from the bundle ───────────────
// Each tool in the bundle looks like:
//   De.registerTool("ctx_xxx",{title:"...",description:`...`,inputSchema:O.object({...})},async...);
// We extract the description (backtick template literal) and the inputSchema
// (TypeBox O.object({...}) call).
async function extractCtxTools() {
  const src = await readFile(CTX_BUNDLE, "utf8");
  // Find each De.registerTool("ctx_xxx", { ... }, async
  const tools = [];
  const re = /De\.registerTool\("([a-z_]+)"\s*,\s*\{([\s\S]*?)\}\s*,\s*async/g;
  let m;
  while ((m = re.exec(src))) {
    const name = m[1];
    const body = m[2];
    // Pull title and description.
    const titleMatch = body.match(/title:\s*"([^"]+)"/);
    const descMatch = body.match(/description:\s*`([\s\S]*?)`\s*,/);
    // Pull inputSchema (could be O.object({...}) or a variable).
    const schemaMatch = body.match(/inputSchema:\s*([A-Za-z_$][\w$]*\.object\([\s\S]*?\)\s*[,}]|O\.object\([\s\S]*?\)\s*[,}])/);
    tools.push({
      name,
      title: titleMatch ? titleMatch[1] : "",
      description: descMatch ? descMatch[1] : "",
      schema: schemaMatch ? schemaMatch[1] : "",
    });
  }
  return tools;
}

const ctxTools = await extractCtxTools();

// ─── 3. Extract tick tool definitions (text-based, less accurate) ────
async function extractTickTools() {
  const src = await readFile(TICK_EXT, "utf8");
  // Each registerTool has name, label, description, promptSnippet, promptGuidelines, parameters.
  const tools = [];
  const re = /registerTool\(\{[\s\S]*?name:\s*"([a-z_]+)"[\s\S]*?description:\s*"([^"]+)"[\s\S]*?parameters:\s*Type\.Object\(([\s\S]*?)\),?\s*\}[\s\S]*?\}\);/g;
  let m;
  while ((m = re.exec(src))) {
    tools.push({
      name: m[1],
      description: m[2],
      schema: m[3],
    });
  }
  return tools;
}

const tickTools = await extractTickTools();

// ─── 4. Build system prompt ──────────────────────────────────────────
const prompt = buildSystemPrompt({
  customPrompt: undefined,
  selectedTools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
  toolSnippets,
  promptGuidelines: [
    "Be concise in your responses",
    "Show file paths clearly when working with files",
  ],
  appendSystemPrompt: undefined,
  cwd: "/Users/gs/Dev/coding/temp-project",
  contextFiles: [],
  skills: [],
});

// ─── 5. Build tool catalog as the API sees it ───────────────────────
const builtinCatalog = toolDefs.map(({ def }) => ({
  name: def.name,
  description: def.description,
  input_schema: def.parameters,
}));
const tickCatalog = tickTools.map((t) => ({
  name: t.name,
  description: t.description,
  input_schema: { type: "object", properties: {} }, // placeholder; real schema is bigger
}));
const ctxCatalog = ctxTools.map((t) => ({
  name: t.name,
  description: t.description,
  input_schema: { type: "object", properties: {} }, // placeholder
}));

// ─── 6. Print breakdown ──────────────────────────────────────────────
console.log("Component                                       tokens  chars");
console.log("─────────────────────────────────────────────  ──────  ──────");

const sysPromptTokens = tok(prompt);
const sysPromptChars = prompt.length;
console.log(`1. System prompt (pi default)               ${String(sysPromptTokens).padStart(7)} ${String(sysPromptChars).padStart(7)}`);

const builtinJson = JSON.stringify(builtinCatalog);
const builtinTokens = tok(builtinJson);
const builtinChars = builtinJson.length;
console.log(`2. Built-in tool catalog (${builtinCatalog.length} tools)         ${String(builtinTokens).padStart(7)} ${String(builtinChars).padStart(7)}`);

// Per-tool breakdown for built-ins
console.log(`   per-tool (description + schema):`);
for (const { def } of toolDefs) {
  const j = JSON.stringify({ name: def.name, description: def.description, input_schema: def.parameters });
  console.log(`     ${def.name.padEnd(8)}  ${String(tok(j)).padStart(5)} tokens`);
}

const tickJson = JSON.stringify(tickCatalog);
const tickTokens = tok(tickJson);
const tickChars = tickJson.length;
console.log(`3. pi-tick tool catalog (${tickCatalog.length} tools)            ${String(tickTokens).padStart(7)} ${String(tickChars).padStart(7)}`);

// Per-tool breakdown for tick
console.log(`   per-tool (description only; real schemas in extension):`);
for (const t of tickTools) {
  console.log(`     ${t.name.padEnd(14)}  ${String(tok(t.description)).padStart(5)} tokens (desc)`);
}

const ctxJson = JSON.stringify(ctxCatalog);
const ctxTokens = tok(ctxJson);
const ctxChars = ctxJson.length;
console.log(`4. context-mode tool catalog (${ctxCatalog.length} tools)      ${String(ctxTokens).padStart(7)} ${String(ctxChars).padStart(7)}`);

// Per-tool breakdown for context-mode — descriptions are huge
console.log(`   per-tool (description only; real schemas in bundle):`);
for (const t of ctxTools) {
  console.log(`     ${t.name.padEnd(20)}  ${String(tok(t.description)).padStart(5)} tokens (desc)`);
}

const userMsgTokens = tok("hello world");
const userMsgChars = "hello world".length;
console.log(`5. User message ("hello world")              ${String(userMsgTokens).padStart(7)} ${String(userMsgChars).padStart(7)}`);

const framingTokens = 20; // role tag, content array, etc.
console.log(`6. Message framing / role tags                 ${String(framingTokens).padStart(7)}`);

const total = sysPromptTokens + builtinTokens + tickTokens + ctxTokens + userMsgTokens + framingTokens;
console.log("─────────────────────────────────────────────  ──────  ──────");
console.log(`TOTAL (estimate)                              ${String(total).padStart(7)}`);
console.log();
console.log("Observed in actual run:  input=11494, cacheRead=114, output=38");
console.log(`  prompt side: 11608 tokens (input + cacheRead + cacheWrite)`);
console.log(`  match within ${Math.abs(total - 11608) / 11608 * 100 | 0}% (estimate vs API)`);

console.log("\nCost at Claude Sonnet 4.5 pricing ($3/$15 per MTok, cache $0.30/MTok):");
const uncachedCost = (11608 * 3.0 + 38 * 15) / 1_000_000;
const cachedCost = (11494 * 3.0 + 38 * 15 + 114 * 0.30) / 1_000_000;
console.log(`  Per call (this run, mostly cached):  $${cachedCost.toFixed(4)}`);
console.log(`  Per call (cold, no cache):           $${uncachedCost.toFixed(4)}`);
console.log(`  Hourly ticks × 60 (all cached):      $${(60 * cachedCost).toFixed(3)}/hr`);
console.log(`  Hourly ticks × 60 (all cold):         $${(60 * uncachedCost).toFixed(3)}/hr`);
console.log();
console.log("This run's cost (from message_end.cost):");
console.log(`  input $0.0069 + output $0.0001 + cacheRead $0.0000 = $0.0070/run`);
console.log(`  (MiniMax pricing, presumably ≈ $0.6/MTok in + $15/MTok out)`);
