#!/usr/bin/env node
// Remus guard for Claude Code. Runs as a PreToolUse hook: before a tool call executes, it asks Remus whether the
// agent may make that call, and turns the answer into a Claude Code permission decision.
//
//   Remus deny    -> the call is denied, with the rule as the reason.
//   Remus review  -> wait for a reviewer (up to review_wait_seconds); approved continues, rejected denies,
//                    no answer in time denies (or, if configured, asks the person at the keyboard).
//   Remus allow   -> by default no decision: Claude Code's normal permission flow applies. Remus never widens what
//                    Claude Code would allow unless on_allow is set to "approve".
//   Remus unreachable, key missing, allowance used up -> denied (fail closed), unless on_error says otherwise.
//
// One file, no dependencies: the client is the built-in fetch. Usage: node guard.mjs pre|post  (hook JSON on stdin).
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_API_URL = 'https://api.remus.new-odyssey.com';
export const DEFAULT_TOOLS = 'Bash,Write,Edit,MultiEdit,NotebookEdit,WebFetch,mcp__*';
const MAX_ARGS_BYTES = 12000; // the API accepts 16 KiB of args; stay well inside it
const sha = value => createHash('sha256').update(value).digest('hex');

// --- Configuration --------------------------------------------------------------------------------------------------
/** Plugin options arrive as CLAUDE_PLUGIN_OPTION_<KEY>; REMUS_GUARD_<KEY> works without the plugin system. */
export function readConfig(env) {
  const raw = name => { const value = env[`CLAUDE_PLUGIN_OPTION_${name}`] || env[`REMUS_GUARD_${name}`]; return value === undefined || value === '' ? undefined : String(value); };
  const choice = (name, allowed, fallback) => { const value = raw(name)?.toLowerCase(); return allowed.includes(value) ? value : fallback; };
  const number = (name, fallback, min, max) => { const value = Number(raw(name)); return Number.isFinite(value) && raw(name) !== undefined ? Math.min(max, Math.max(min, value)) : fallback; };
  const list = (name, fallback) => (raw(name) ?? fallback).split(',').map(item => item.trim()).filter(Boolean);
  return {
    key: raw('AGENT_KEY') || env.REMUS_AGENT_KEY || '',
    apiUrl: raw('API_URL') || env.REMUS_API_URL || DEFAULT_API_URL,
    // An unrecognised value falls back to the stricter choice.
    onAllow: choice('ON_ALLOW', ['prompt', 'approve'], 'prompt'),
    // A rule that requires a reviewer is not something the person at the keyboard can wave through, unless they opt in.
    onReviewTimeout: choice('ON_REVIEW_TIMEOUT', ['ask', 'deny'], 'deny'),
    // How much of a file's content (and of an MCP tool's input) is sent: a clipped preview, only a hash, or nothing.
    content: choice('CONTENT', ['preview', 'hash', 'none'], raw('CONTENT') ? 'none' : 'preview'),
    onError: choice('ON_ERROR', ['deny', 'ask', 'pass'], 'deny'),
    reviewWaitSeconds: number('REVIEW_WAIT_SECONDS', 60, 0, 300),
    timeoutMs: number('TIMEOUT_MS', 4000, 500, 30000),
    tools: list('TOOLS', DEFAULT_TOOLS),
    skipTools: list('SKIP_TOOLS', ''),
    recordOutcomes: ['true', '1', 'yes', 'on'].includes((raw('RECORD_OUTCOMES') || '').toLowerCase()),
    projectDir: env.CLAUDE_PROJECT_DIR || '',
    stateDir: env.CLAUDE_PLUGIN_DATA || join(tmpdir(), `remus-guard-${safeUser()}`),
  };
}
function safeUser() { try { return String(userInfo().uid >= 0 ? userInfo().uid : userInfo().username).replace(/[^A-Za-z0-9_-]/g, '_'); } catch { return 'user'; } }

/** Tool-name patterns: exact names, with * as a wildcard (so mcp__* covers every MCP tool). */
export function matches(name, patterns) {
  return patterns.some(pattern => new RegExp(`^${pattern.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`).test(name));
}

// --- Turning a tool call into a Remus request -----------------------------------------------------------------------
const clean = value => String(value).replaceAll('\u0000', '').replace(/\\u0000/gi, '\\u{0}'); // the API refuses NUL in any form
const clip = (value, max) => { const text = clean(value); return text.length > max ? `${text.slice(0, max)}…[${text.length - max} more characters]` : text; };
const snake = name => name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
const segment = value => String(value).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 48) || '_';

/** claude.bash, claude.write, claude.multi_edit, claude.mcp.<server>.<tool> */
export function actionFor(toolName) {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(toolName);
  return (mcp ? `claude.mcp.${segment(mcp[1])}.${segment(mcp[2])}` : `claude.${segment(snake(toolName))}`).slice(0, 128);
}

/** A resource is 1 to 256 printable characters and never "." or "..". Long or odd values keep a stable hash suffix. */
export function resourceOf(value) {
  let text = clean(value).replace(/[\u0000-\u001f\u007f]/g, ' ').trim() || 'none';
  if (text === '.' || text === '..') text = `${text}/`;
  return text.length > 256 ? `${text.slice(0, 240)}#${sha(text).slice(0, 12)}` : text;
}

function place(path, projectDir) {
  const absolute = resolve(path);
  const rel = projectDir ? relative(resolve(projectDir), absolute) : '';
  const inProject = Boolean(projectDir) && !rel.startsWith('..') && !isAbsolute(rel);
  return { absolute, inProject, shown: inProject ? (rel.split(sep).join('/') || '.') : absolute.split(sep).join('/') };
}

/** The program a shell command starts with: leading VAR=value assignments and the path to the binary are dropped. */
export function firstWord(command) {
  const words = String(command).trim().split(/\s+/);
  while (words.length > 1 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words.shift();
  const program = basename(words[0] || '').replace(/^[("'`]+/, '');
  return program ? segment(program) : 'none';
}

/** File names and directories whose content is never sent, whatever the content setting: only a hash and a length. */
export function looksSecret(path) {
  const parts = String(path).split(/[\\/]/);
  const name = (parts[parts.length - 1] || '').toLowerCase();
  if (parts.slice(0, -1).some(part => ['.ssh', '.aws', '.gnupg', '.kube', '.docker', 'secrets'].includes(part.toLowerCase()))) return true;
  return /^\.env(\..*)?$/.test(name) || /\.(pem|key|p12|pfx|jks|keystore|kdbx|asc|gpg)$/.test(name) || /^id_(rsa|dsa|ecdsa|ed25519)/.test(name)
    || /^credentials/.test(name) || /secret|passwd|password|token/.test(name) || ['.netrc', '.npmrc', '.pypirc', '.pgpass', '.htpasswd'].includes(name);
}

/** One piece of content as args, according to the content setting: preview (clipped text), hash, or nothing. */
function contentArgs(prefix, text, mode, limit) {
  if (mode === 'none') return {};
  const digest = { [`${prefix}_bytes`]: Buffer.byteLength(text), [`${prefix}_sha256`]: sha(text) };
  return mode === 'preview' ? { ...digest, [`${prefix}_preview`]: clip(text, limit) } : digest;
}

/** Shrinks arbitrary tool input until it fits: long strings are clipped, and as a last resort only a digest is sent. */
function compact(input) {
  const shrink = (value, depth) => {
    if (typeof value === 'string') return clip(value, 1000);
    if (value === null || typeof value !== 'object') return value;
    if (depth >= 5) return '[nested]';
    if (Array.isArray(value)) return value.slice(0, 50).map(item => shrink(item, depth + 1));
    return Object.fromEntries(Object.entries(value).slice(0, 50).map(([key, item]) => [clean(key).slice(0, 100), shrink(item, depth + 1)]));
  };
  const shrunk = shrink(input && typeof input === 'object' && !Array.isArray(input) ? input : {}, 0);
  return fit(shrunk);
}
function fit(args) {
  const text = JSON.stringify(args);
  if (Buffer.byteLength(text) <= MAX_ARGS_BYTES) return args;
  return { input_truncated: true, input_bytes: Buffer.byteLength(text), input_sha256: sha(text), keys: Object.keys(args).slice(0, 50) };
}

/**
 * The Remus request for one tool call: { action, resource, args }.
 *   Files:  resource is the path (relative to the project when inside it); args say whether it is inside the project,
 *           and carry the change as a preview, a hash or nothing (the `content` setting; secret-looking paths: hash).
 *   Bash:   resource is "<program>:<working directory>"; args carry the command.
 *   Other:  resource names the target (URL, or MCP server/tool); args are the tool input, clipped.
 */
export function describe(hook, projectDir, content = 'preview') {
  const tool = hook.tool_name; const input = hook.tool_input && typeof hook.tool_input === 'object' ? hook.tool_input : {};
  const project = projectDir || hook.cwd || '';
  const action = actionFor(tool);
  const filePath = input.file_path ?? input.notebook_path;
  if (tool === 'Bash') {
    const cwd = place(hook.cwd || project || '.', project);
    const command = String(input.command ?? '');
    return { action, resource: resourceOf(`${firstWord(command)}:${cwd.shown}`), args: fit({ command: clip(command, 8000), program: firstWord(command), cwd: cwd.shown, in_project: cwd.inProject, background: Boolean(input.run_in_background), ...(input.description ? { description: clip(input.description, 300) } : {}) }) };
  }
  if (typeof filePath === 'string' && filePath) {
    const file = place(filePath, project);
    const args = { path: file.shown, in_project: file.inProject, file_name: basename(file.absolute), extension: extname(file.absolute).slice(1).toLowerCase() };
    // Content of a path that looks like key material or an environment file never leaves the machine as text.
    const secret = looksSecret(file.absolute);
    const mode = secret && content === 'preview' ? 'hash' : content;
    if (secret) args.sensitive_path = true;
    if (typeof input.content === 'string') Object.assign(args, contentArgs('content', input.content, mode, 2000));
    if (typeof input.old_string === 'string') Object.assign(args, contentArgs('old', input.old_string, mode, 2000));
    if (typeof input.new_string === 'string') Object.assign(args, contentArgs('new', input.new_string, mode, 2000));
    if (typeof input.new_source === 'string') Object.assign(args, contentArgs('new', input.new_source, mode, 2000));
    if (input.replace_all !== undefined) args.replace_all = Boolean(input.replace_all);
    if (Array.isArray(input.edits)) args.edits = input.edits.length;
    return { action, resource: resourceOf(file.shown), args: fit(args) };
  }
  if (typeof input.url === 'string' && input.url) {
    let host = '';
    try { host = new URL(input.url).host; } catch { /* not a URL: leave the host empty */ }
    return { action, resource: resourceOf(input.url.split('#')[0]), args: fit({ url: clip(input.url, 2000), host }) };
  }
  const mcp = /^mcp__(.+?)__(.+)$/.exec(tool);
  const text = JSON.stringify(input);
  const args = content === 'preview' ? compact(input) : { keys: Object.keys(input).slice(0, 50).map(key => clean(key).slice(0, 100)), ...(content === 'hash' ? { input_bytes: Buffer.byteLength(text), input_sha256: sha(text) } : {}) };
  return { action, resource: resourceOf(mcp ? `${mcp[1]}/${mcp[2]}` : tool), args };
}

/** One key per tool call, so a hook that is run twice for the same call reaches the same Remus request. */
export function idempotencyKey(hook, request) {
  const basis = hook.tool_use_id ? `${hook.session_id || ''}:${hook.tool_use_id}` : `${hook.session_id || ''}:${JSON.stringify(request)}`;
  return `cc-${sha(basis).slice(0, 48)}`;
}

// --- Remus client ---------------------------------------------------------------------------------------------------
class GuardError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

export function checkApiUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new GuardError('invalid_api_url', 'The Remus API URL is not a valid URL.'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) throw new GuardError('invalid_api_url', 'The Remus API URL must use https (http is accepted for localhost only).');
  if (url.username || url.password || url.search || url.hash) throw new GuardError('invalid_api_url', 'The Remus API URL must not contain credentials, a query or a fragment.');
  return url.origin + url.pathname.replace(/\/+$/, '');
}

function client(config) {
  const base = checkApiUrl(config.apiUrl);
  return async function call(method, path, body, headers = {}) {
    let response;
    try {
      response = await fetch(`${base}${path}`, {
        method, redirect: 'error', signal: AbortSignal.timeout(config.timeoutMs),
        headers: { authorization: `Bearer ${config.key}`, accept: 'application/json', 'user-agent': 'remus-guard/1', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch { throw new GuardError('unreachable', 'Remus could not be reached.'); }
    let json = null;
    try { json = await response.json(); } catch { /* not JSON */ }
    if (response.ok && json) return json;
    const error = json?.error || {};
    throw Object.assign(new GuardError(error.code || `http_${response.status}`, error.message || `Remus answered with status ${response.status}.`), { status: response.status });
  };
}

// --- Local state: held requests waiting for a reviewer, and calls whose outcome is to be reported ------------------
function stateFile(config, kind, name) {
  const dir = join(config.stateDir, kind);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return join(dir, `${name}.json`);
}
function readState(config, kind, name) {
  try { return JSON.parse(readFileSync(stateFile(config, kind, name), 'utf8')); } catch { return null; }
}
function writeState(config, kind, name, value) {
  try { writeFileSync(stateFile(config, kind, name), JSON.stringify(value), { mode: 0o600 }); } catch { /* state is an optimisation, never a requirement */ }
}
function dropState(config, kind, name) {
  try { rmSync(stateFile(config, kind, name), { force: true }); } catch { /* ignore */ }
}
function sweepState(config) {
  try {
    for (const kind of ['held', 'calls']) {
      const dir = join(config.stateDir, kind);
      for (const file of readdirSync(dir)) if (Date.now() - statSync(join(dir, file)).mtimeMs > 8 * 86400000) rmSync(join(dir, file), { force: true });
    }
  } catch { /* ignore */ }
}
const sameRequest = (stored, request) => stored && stored.action === request.action && stored.resource === request.resource && canonical(stored.args) === canonical(request.args);
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

// --- Decisions ------------------------------------------------------------------------------------------------------
const output = (permissionDecision, permissionDecisionReason) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision, permissionDecisionReason } });
const NO_WORKAROUND = 'Do not retry it under another tool, split it into smaller steps or reach the same result another way. Tell the user what was refused and why.';
const sleep = ms => new Promise(done => setTimeout(done, ms));

/**
 * Decides one PreToolUse call. Returns the JSON to print, or null for "no decision" (Claude Code's normal permission
 * flow applies).
 */
export async function decide(hook, config) {
  if (!hook || typeof hook.tool_name !== 'string') throw new GuardError('bad_input', 'The hook input has no tool name.');
  if (!matches(hook.tool_name, config.tools) || matches(hook.tool_name, config.skipTools)) return null;
  if (!config.key) throw new GuardError('missing_key', 'No Remus agent key is configured. Set it in the plugin options, or export REMUS_AGENT_KEY.');
  const call = client(config);
  const request = describe(hook, config.projectDir, config.content);
  const callKey = idempotencyKey(hook, request);
  const contentKey = sha(canonical(request)).slice(0, 48);
  const proceed = async (remus, reviewed) => {
    // A reviewed request is single-use: claim it now, so the same approval cannot let a second call through.
    if (reviewed || config.recordOutcomes) {
      await call('POST', `/v1/requests/${remus.id}/authorize`, {});
      if (config.recordOutcomes) writeState(config, 'calls', callKey, { id: remus.id });
    }
    dropState(config, 'held', contentKey);
    return config.onAllow === 'approve' ? output('allow', `Allowed by Remus (rule ${remus.rule}, request ${remus.id}).`) : null;
  };
  const refuse = (remus, why) => { dropState(config, 'held', contentKey); return output('deny', `${why} Request ${remus.id}. ${NO_WORKAROUND}`); };

  // If an identical call was held earlier and is still waiting or has since been approved, continue with that request
  // instead of asking the reviewer again. The stored ID is only a pointer: Remus must return the same action, resource
  // and arguments, so a forged pointer cannot attach someone else's approval to this call.
  let remus = null;
  const earlier = readState(config, 'held', contentKey);
  if (earlier?.id) {
    try { const found = await call('GET', `/v1/requests/${encodeURIComponent(earlier.id)}`); if (sameRequest(found, request) && ['pending_approval', 'approved'].includes(found.status)) remus = found; } catch (error) { if (error.code !== 'not_found') throw error; }
    if (!remus) dropState(config, 'held', contentKey);
  }
  remus ??= await call('POST', '/v1/requests', request, { 'idempotency-key': callKey });

  if (remus.decision === 'deny') return refuse(remus, `Remus denied this ${hook.tool_name} call: rule "${remus.rule}"${remus.reason ? ` (${remus.reason})` : ''}.`);
  if (remus.decision === 'allow') return proceed(remus, false);

  // review: nothing runs until a reviewer approves this exact request.
  writeState(config, 'held', contentKey, { id: remus.id });
  const deadline = Date.now() + config.reviewWaitSeconds * 1000;
  while (remus.status === 'pending_approval' && Date.now() + 1000 < deadline) {
    await sleep(Math.min(2000, Math.max(250, deadline - Date.now() - 500)));
    remus = await call('GET', `/v1/requests/${remus.id}`);
  }
  if (remus.status === 'approved') {
    try { return await proceed(remus, true); }
    catch (error) {
      if (['approval_expired', 'policy_changed', 'execution_already_claimed', 'approval_required', 'denied', 'grant_expired', 'grant_revoked'].includes(error.code)) return refuse(remus, `Remus approved this call earlier but will not let it run now (${error.code}).`);
      throw error;
    }
  }
  if (remus.status === 'rejected') return refuse(remus, `A reviewer rejected this ${hook.tool_name} call (rule "${remus.rule}").`);
  if (remus.status !== 'pending_approval') return refuse(remus, `The approval for this ${hook.tool_name} call is no longer valid (${remus.status}).`);
  const waiting = `Remus is holding this ${hook.tool_name} call for a reviewer (rule "${remus.rule}", request ${remus.id}) and it has not been approved yet.`;
  if (config.onReviewTimeout === 'ask') return output('ask', `${waiting} Approving here overrides the review for this one call.`);
  return output('deny', `${waiting} Nothing has run. Stop and tell the user it is waiting for approval in Remus; when they say it is approved, make the same call again. ${NO_WORKAROUND}`);
}

/** Maps a failure to a decision. Fail closed unless the user chose otherwise. */
export function onFailure(error, config) {
  const reasons = {
    missing_key: 'No Remus agent key is configured.', unreachable: 'Remus could not be reached.', unauthorized: 'Remus rejected the agent key.',
    agent_disabled: 'This agent is disabled in Remus.', decision_allowance_exhausted: 'The Remus workspace has used all its policy decisions for this period.',
    rate_limited: 'Remus is rate limiting this key.', invalid_api_url: error.message,
  };
  const reason = reasons[error?.code] || (error instanceof GuardError ? `Remus could not decide (${error.code}).` : 'The Remus guard failed unexpectedly.');
  if (error?.code === 'invalid_arguments') return output('deny', `Remus refused the arguments of this call: ${String(error.message).slice(0, 300)} ${NO_WORKAROUND}`);
  if (config.onError === 'pass') return null;
  if (config.onError === 'ask') return output('ask', `${reason} Remus has not checked this call. Approve only if you accept that.`);
  return output('deny', `${reason} Remus has not checked this call, so it is refused (the guard fails closed). ${NO_WORKAROUND}`);
}

/** After the tool ran (or failed): report the outcome for calls that were claimed in Remus. */
export async function report(hook, config, status) {
  if (!config.recordOutcomes || !config.key || !hook?.tool_name) return;
  const callKey = idempotencyKey(hook, describe(hook, config.projectDir, config.content));
  const claimed = readState(config, 'calls', callKey);
  if (!claimed?.id) return;
  await client(config)('POST', `/v1/requests/${encodeURIComponent(claimed.id)}/outcome`, { status, result: { tool: hook.tool_name } });
  dropState(config, 'calls', callKey);
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function main(mode) {
  const config = readConfig(process.env);
  if (mode === 'pre') {
    let result;
    try { result = await decide(JSON.parse(await readStdin()), config); }
    catch (error) { result = onFailure(error, config); }
    if (result) process.stdout.write(`${JSON.stringify(result)}\n`);
    if (Math.random() < 0.02) sweepState(config);
    return;
  }
  // post-ok / post-failed: best effort, never blocks or changes anything in the session.
  try { await report(JSON.parse(await readStdin()), config, mode === 'post-failed' ? 'failed' : 'succeeded'); } catch { /* the request stays open and Remus marks it unknown */ }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const mode = process.argv[2] || 'pre';
  if (!['pre', 'post-ok', 'post-failed'].includes(mode)) { process.stderr.write('usage: guard.mjs pre|post-ok|post-failed\n'); process.exit(2); }
  await main(mode);
}
