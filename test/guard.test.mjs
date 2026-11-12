// The guard, run as Claude Code runs it (a child process fed recorded hook input on stdin), against the real Remus
// service code started in-process on Postgres. Set REMUS_SERVICE_DIR if the Remus checkout is not a sibling directory.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test, { after, before } from 'node:test';
import { fileURLToPath } from 'node:url';
import { actionFor, describe, firstWord, idempotencyKey, looksSecret, matches, readConfig, resourceOf } from '../scripts/guard.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const serviceDir = resolve(process.env.REMUS_SERVICE_DIR || join(root, '../Remus/service'));
const { createTenant, db, startTestService } = await import(join(serviceDir, 'test/helpers.js'));
const { validatePolicy } = await import(join(serviceDir, 'src/policy.js'));
const guard = join(root, 'scripts/guard.mjs');
const fixture = name => JSON.parse(readFileSync(join(root, 'test/fixtures', `${name}.json`), 'utf8'));
const starter = JSON.parse(readFileSync(join(root, 'policies/claude-code-starter.json'), 'utf8'));

let service; let tenant; let calls = 0;
before(async () => {
  service = await startTestService();
  tenant = await createTenant(service.url, { plan: 'developer', policy: starter, agentName: 'claude-code' });
});
after(() => service.close());

/** Runs the guard. `hook` is a fixture name or an object; each run gets a fresh tool_use_id unless one is forced. */
function run(hook, { env = {}, mode = 'pre', keepId = false, stdin } = {}) {
  const input = typeof hook === 'string' ? fixture(hook) : hook;
  if (!keepId) input.tool_use_id = `toolu_test_${++calls}_${Date.now()}`;
  return new Promise(done => {
    const child = spawn(process.execPath, [guard, mode], { env: { PATH: process.env.PATH, CLAUDE_PROJECT_DIR: '/home/dev/shop', CLAUDE_PLUGIN_DATA: stateDir, CLAUDE_PLUGIN_OPTION_AGENT_KEY: tenant.agentKey, CLAUDE_PLUGIN_OPTION_API_URL: service.url, CLAUDE_PLUGIN_OPTION_REVIEW_WAIT_SECONDS: '0', ...env } });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', code => done({ code, stdout, stderr, input, decision: stdout.trim() ? JSON.parse(stdout).hookSpecificOutput : null }));
    child.stdin.end(stdin ?? JSON.stringify(input));
  });
}
const stateDir = mkdtempSync(join(tmpdir(), 'remus-guard-test-'));
const latest = async () => (await tenant.admin.history.requests({ limit: 1 })).items[0];
const total = async () => Number((await db()('requests').where({ org_id: tenant.org.id }).count().first()).count);

test('the starter policy is valid and plugin.json, hooks.json and the fixtures agree with the guard', () => {
  assert.deepEqual(validatePolicy(starter), []);
  const hooks = JSON.parse(readFileSync(join(root, 'hooks/hooks.json'), 'utf8')).hooks;
  const pre = hooks.PreToolUse[0];
  assert.deepEqual(pre.hooks[0].args, ['${CLAUDE_PLUGIN_ROOT}/scripts/guard.mjs', 'pre']);
  assert.equal(pre.hooks[0].onFailure, 'block', 'a crashed or timed-out guard blocks the call');
  const matcher = new RegExp(pre.matcher);
  for (const name of readConfig({}).tools.map(tool => tool.replace('*', 'server__tool'))) assert.ok(matcher.test(name), `${name} reaches the hook`);
  assert.ok(!matcher.test('Read') && !matcher.test('NotebookEditor'));
  const manifest = JSON.parse(readFileSync(join(root, '.claude-plugin/plugin.json'), 'utf8'));
  // Every option the guard reads is declared, with defaults that match the guard's own.
  const defaults = readConfig({});
  assert.deepEqual(Object.keys(manifest.userConfig).sort(), ['agent_key', 'api_url', 'content', 'on_allow', 'on_error', 'on_review_timeout', 'record_outcomes', 'review_wait_seconds', 'skip_tools', 'timeout_ms', 'tools']);
  assert.deepEqual([manifest.userConfig.on_allow.default, manifest.userConfig.on_error.default, manifest.userConfig.on_review_timeout.default, manifest.userConfig.review_wait_seconds.default, manifest.userConfig.timeout_ms.default, manifest.userConfig.tools.default, manifest.userConfig.record_outcomes.default, manifest.userConfig.content.default],
    [defaults.onAllow, defaults.onError, defaults.onReviewTimeout, defaults.reviewWaitSeconds, defaults.timeoutMs, defaults.tools.join(','), defaults.recordOutcomes, defaults.content]);
  assert.deepEqual([defaults.onReviewTimeout, defaults.onError, defaults.onAllow], ['deny', 'deny', 'prompt'], 'the defaults are the strict choices');
  assert.equal(manifest.userConfig.agent_key.sensitive, true);
  assert.equal(readdirSync(join(root, 'test/fixtures')).length, 10);
});

test('how a tool call becomes a Remus request: action, resource, args and idempotency key', () => {
  assert.deepEqual(['Bash', 'Write', 'MultiEdit', 'NotebookEdit', 'WebFetch', 'mcp__github__create_issue', 'mcp__plugin_my-plugin_db__run.query'].map(actionFor),
    ['claude.bash', 'claude.write', 'claude.multi_edit', 'claude.notebook_edit', 'claude.web_fetch', 'claude.mcp.github.create_issue', 'claude.mcp.plugin_my-plugin_db.run_query']);
  const project = '/home/dev/shop';
  assert.deepEqual(describe(fixture('bash-test'), project), { action: 'claude.bash', resource: 'npm:.', args: { command: 'npm test', program: 'npm', cwd: '.', in_project: true, background: false, description: 'Run test suite' } });
  assert.deepEqual([describe(fixture('bash-outside'), project).resource, describe(fixture('bash-outside'), project).args.in_project], ['ls:/etc', false]);
  const write = describe(fixture('write-inside'), project);
  assert.deepEqual([write.action, write.resource, write.args.in_project, write.args.extension, write.args.content_bytes], ['claude.write', 'src/cart.js', true, 'js', 80]);
  assert.match(write.args.content_sha256, /^[a-f0-9]{64}$/);
  const edit = describe(fixture('edit-outside'), project);
  assert.deepEqual([edit.resource, edit.args.in_project, edit.args.old_preview, edit.args.new_preview], ['/home/dev/.zshrc', false, 'export PATH=', 'export PATH=/tmp/bin:']);
  assert.deepEqual(describe(fixture('mcp-call'), project), { action: 'claude.mcp.github.create_issue', resource: 'github/create_issue', args: fixture('mcp-call').tool_input });
  assert.deepEqual(describe(fixture('webfetch'), project), { action: 'claude.web_fetch', resource: 'https://example.com/docs/api', args: { url: 'https://example.com/docs/api#auth', host: 'example.com' } });
  // A path that climbs out of the project is outside it, whatever it looks like.
  assert.equal(describe({ tool_name: 'Write', cwd: project, tool_input: { file_path: '/home/dev/shop/../other/x.js', content: '' } }, project).args.in_project, false);
  assert.equal(describe({ tool_name: 'Write', cwd: project, tool_input: { file_path: '/home/dev/shop-backup/x.js', content: '' } }, project).args.in_project, false);
  assert.deepEqual(['FOO=1 BAR=2 /usr/bin/git status', '  rm -rf x', '(cd x && make)', ''].map(firstWord), ['git', 'rm', 'cd', 'none']);
  // Oversized input never exceeds the API's argument limit, and NUL never reaches the API.
  const big = describe({ tool_name: 'Write', cwd: project, tool_input: { file_path: `${project}/big.txt`, content: 'x'.repeat(500000) } }, project);
  assert.ok(Buffer.byteLength(JSON.stringify(big.args)) < 16000 && big.args.content_bytes === 500000);
  const huge = describe({ tool_name: 'mcp__db__query', cwd: project, tool_input: Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`field${index}`, 'y'.repeat(900)])) }, project);
  assert.deepEqual([huge.args.input_truncated, typeof huge.args.input_sha256], [true, 'string']);
  const nul = JSON.stringify(describe({ tool_name: 'Bash', cwd: project, tool_input: { command: 'printf "a\u0000b" && echo "\\u0000"' } }, project));
  assert.ok(!nul.includes('\\u0000') && !/\\\\u0000/i.test(nul));
  assert.deepEqual([resourceOf('.'), resourceOf('..'), resourceOf(''), resourceOf('a\nb').includes('\n'), resourceOf('p'.repeat(400)).length], ['./', '../', 'none', false, 253]);
  assert.equal(idempotencyKey(fixture('bash-test'), {}), idempotencyKey(fixture('bash-test'), { other: 1 }), 'stable per tool call');
  assert.notEqual(idempotencyKey(fixture('bash-test'), {}), idempotencyKey(fixture('bash-rm'), {}));
  assert.match(idempotencyKey(fixture('bash-test'), {}), /^cc-[a-f0-9]{48}$/);
  assert.deepEqual([matches('mcp__github__create_issue', ['mcp__*']), matches('Bash', ['Bash', 'Write']), matches('BashOutput', ['Bash']), matches('Read', ['*']), matches('Edit', [])], [true, true, false, true, false]);
});

test('Remus allow: no decision by default (Claude Code\'s own permission flow applies); approve only when opted in', async () => {
  const before = await total();
  const result = await run('bash-test');
  assert.deepEqual([result.code, result.stdout, result.stderr], [0, '', ''], 'silent: the normal permission flow continues');
  const recorded = await latest();
  assert.deepEqual([recorded.action, recorded.resource, recorded.decision, recorded.rule, recorded.status, recorded.agent], ['claude.bash', 'npm:.', 'allow', 'shell_inside_project', 'ready', 'claude-code']);
  assert.equal(await total(), before + 1, 'one request per tool call');
  const write = await run('write-inside');
  assert.deepEqual([write.stdout, (await latest()).rule], ['', 'edit_inside_project']);
  assert.deepEqual([(await run('webfetch')).stdout, (await latest()).rule], ['', 'web_fetch']);
  // Opt-in: Remus allow becomes a Claude Code allow.
  const approved = await run('bash-test', { env: { CLAUDE_PLUGIN_OPTION_ON_ALLOW: 'approve' } });
  assert.deepEqual([approved.decision.hookEventName, approved.decision.permissionDecision], ['PreToolUse', 'allow']);
  assert.match(approved.decision.permissionDecisionReason, /Allowed by Remus \(rule shell_inside_project/);
  // An unrecognised setting does not widen anything.
  assert.equal((await run('bash-test', { env: { CLAUDE_PLUGIN_OPTION_ON_ALLOW: 'yes-please' } })).stdout, '');
  // The same tool call seen twice (same tool_use_id) reaches the same request.
  const count = await total();
  const first = fixture('bash-test'); first.tool_use_id = 'toolu_same_call';
  await run(first, { keepId: true }); await run(structuredClone(first), { keepId: true });
  assert.equal(await total(), count + 1);
});

test('Remus deny: the call is denied with the rule as the reason, whatever on_allow says', async () => {
  for (const [name, rule] of [['bash-sudo', 'deny_sudo'], ['write-env', 'protect_secrets_and_git']]) {
    const result = await run(name, { env: { CLAUDE_PLUGIN_OPTION_ON_ALLOW: 'approve', CLAUDE_PLUGIN_OPTION_ON_ERROR: 'pass' } });
    assert.equal(result.code, 0);
    assert.equal(result.decision.permissionDecision, 'deny');
    assert.match(result.decision.permissionDecisionReason, new RegExp(`Remus denied this \\w+ call: rule "${rule}"`));
    assert.match(result.decision.permissionDecisionReason, /Do not retry it under another tool/);
    assert.equal((await latest()).status, 'denied');
  }
  // No rule at all: default deny.
  const unknown = await run({ ...fixture('bash-test'), tool_name: 'WebSearch', tool_input: { query: 'x' } }, { env: { CLAUDE_PLUGIN_OPTION_TOOLS: 'WebSearch' } });
  assert.match(unknown.decision.permissionDecisionReason, /rule "default_deny"/);
  // The secret in the write never reaches Remus in full beyond the preview, and the key is never in the output.
  assert.ok(!JSON.stringify(unknown).includes(tenant.agentKey));
});

test('Remus review: wait for the reviewer; approved continues once, rejected denies, no answer asks or denies', async () => {
  // No answer in time: deny (default), or ask when the user opted in. Nothing is approved in Remus by asking.
  const ASK = { CLAUDE_PLUGIN_OPTION_ON_REVIEW_TIMEOUT: 'ask' };
  const asked = await run('bash-rm', { env: ASK });
  assert.equal(asked.decision.permissionDecision, 'ask');
  assert.match(asked.decision.permissionDecisionReason, /holding this Bash call for a reviewer \(rule "hold_recursive_delete", request [0-9a-f-]{36}\)/);
  const held = await latest();
  assert.deepEqual([held.status, held.decision], ['pending_approval', 'review']);
  const denied = await run('bash-rm');
  assert.equal(denied.decision.permissionDecision, 'deny');
  assert.match(denied.decision.permissionDecisionReason, /waiting for approval in Remus/);
  assert.equal((await latest()).id, held.id, 'the retry waits on the same held request instead of asking the reviewer again');

  // The reviewer approves; the agent makes the same call again: it continues, and the approval is used up.
  await tenant.reviewer.approve(held.id, { requestHash: held.requestHash });
  const count = await total();
  const resumed = await run('bash-rm');
  assert.deepEqual([resumed.stdout, await total()], ['', count], 'continues (normal permission flow) without a new request');
  assert.equal((await tenant.admin.getRequest(held.id)).status, 'executing', 'the approval was claimed');
  const again = await run('bash-rm');
  assert.equal(again.decision.permissionDecision, 'deny', 'a second identical call needs its own approval');
  assert.match(again.decision.permissionDecisionReason, /has not been approved yet/);
  assert.notEqual((await latest()).id, held.id);

  // Approved while the guard is waiting.
  const waiting = run('edit-outside', { env: { CLAUDE_PLUGIN_OPTION_REVIEW_WAIT_SECONDS: '15', CLAUDE_PLUGIN_OPTION_ON_ALLOW: 'approve' } });
  let pending;
  for (let attempt = 0; attempt < 60 && !pending; attempt += 1) { await new Promise(done => setTimeout(done, 100)); pending = (await tenant.reviewer.approvals()).items.find(item => item.action === 'claude.edit'); }
  assert.deepEqual([pending.rule, pending.resource, pending.args.new_preview], ['edit_outside_project', '/home/dev/.zshrc', 'export PATH=/tmp/bin:'], 'the reviewer sees what will change');
  await tenant.reviewer.approve(pending.id, { requestHash: pending.requestHash });
  assert.equal((await waiting).decision.permissionDecision, 'allow');

  // Rejected: denied, and not asked.
  await run('mcp-call');
  const mcp = await latest();
  assert.deepEqual([mcp.action, mcp.rule], ['claude.mcp.github.create_issue', 'mcp_calls']);
  await tenant.reviewer.reject(mcp.id, { requestHash: mcp.requestHash });
  const rejected = await run('mcp-call');
  assert.match(rejected.decision.permissionDecisionReason, /has not been approved yet/, 'a rejected request is not reused; the new call is held again');
  assert.equal((await run('mcp-call', { env: { CLAUDE_PLUGIN_OPTION_ON_REVIEW_TIMEOUT: 'sometimes' } })).decision.permissionDecision, 'deny', 'an unrecognised setting is the strict one');
  const second = await latest();
  await tenant.reviewer.reject(second.id, { requestHash: second.requestHash });
  // ...and when the rejection arrives during the wait:
  const third = run('mcp-call', { env: { CLAUDE_PLUGIN_OPTION_REVIEW_WAIT_SECONDS: '15' } });
  let open;
  for (let attempt = 0; attempt < 60 && !open; attempt += 1) { await new Promise(done => setTimeout(done, 100)); open = (await tenant.reviewer.approvals()).items.find(item => item.action === 'claude.mcp.github.create_issue'); }
  await tenant.reviewer.reject(open.id, { requestHash: open.requestHash });
  const outcome = await third;
  assert.equal(outcome.decision.permissionDecision, 'deny');
  assert.match(outcome.decision.permissionDecisionReason, /A reviewer rejected this mcp__github__create_issue call/);
});

test('an approval cannot be attached to a different call through the local state file', async () => {
  // Approve a harmless held call, then point the state entry of a different call at that approved request.
  const harmless = { ...fixture('bash-outside'), tool_input: { command: 'ls -la' } };
  await run(harmless);
  const approved = await latest();
  await tenant.reviewer.approve(approved.id, { requestHash: approved.requestHash });
  const { createHash } = await import('node:crypto');
  const canonical = value => (value === null || typeof value !== 'object' ? JSON.stringify(value) : Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`);
  const dangerous = { ...fixture('bash-outside'), tool_input: { command: 'rm -rf /etc/nginx' } };
  const key = createHash('sha256').update(canonical(describe(dangerous, '/home/dev/shop'))).digest('hex').slice(0, 48);
  writeFileSync(join(stateDir, 'held', `${key}.json`), JSON.stringify({ id: approved.id }));
  const result = await run(dangerous);
  assert.equal(result.decision.permissionDecision, 'deny', 'held for its own review, not waved through');
  assert.match(result.decision.permissionDecisionReason, /has not been approved yet/);
  assert.equal((await tenant.admin.getRequest(approved.id)).status, 'approved', 'the other approval was not consumed');
  assert.equal((await latest()).args.command, 'rm -rf /etc/nginx');
});

test('fail closed: no key, unreachable, bad key, exhausted allowance, bad input; opt-outs are explicit', async () => {
  const closed = async (env, pattern, hook = 'bash-test', extra = {}) => {
    const result = await run(hook, { env, ...extra });
    assert.equal(result.code, 0);
    assert.equal(result.decision?.permissionDecision, 'deny', JSON.stringify(result));
    assert.match(result.decision.permissionDecisionReason, pattern);
    assert.match(result.decision.permissionDecisionReason, /fails closed/);
    return result;
  };
  await closed({ CLAUDE_PLUGIN_OPTION_AGENT_KEY: '' }, /No Remus agent key is configured/);
  await closed({ CLAUDE_PLUGIN_OPTION_API_URL: 'http://127.0.0.1:9', CLAUDE_PLUGIN_OPTION_TIMEOUT_MS: '1500' }, /Remus could not be reached/);
  await closed({ CLAUDE_PLUGIN_OPTION_API_URL: 'http://example.com' }, /must use https/);
  const badKey = await closed({ CLAUDE_PLUGIN_OPTION_AGENT_KEY: 'remus_agent_AAAAAAAAAAAA_notarealkeynotarealkeynotarealkey' }, /Remus rejected the agent key/);
  assert.ok(!badKey.stdout.includes('notarealkey'));
  await closed({}, /failed unexpectedly/, 'bash-test', { stdin: '{not json' });
  await closed({}, /failed unexpectedly|could not decide/, 'bash-test', { stdin: '' });
  // The key can also come from REMUS_AGENT_KEY when the plugin option is empty.
  assert.equal((await run('bash-test', { env: { CLAUDE_PLUGIN_OPTION_AGENT_KEY: '', REMUS_AGENT_KEY: tenant.agentKey } })).stdout, '');
  // A slow Remus is a timeout, not a pass.
  const { createServer } = await import('node:http');
  const slow = createServer(() => { /* never answers */ });
  await new Promise(done => slow.listen(0, '127.0.0.1', done));
  const started = Date.now();
  await closed({ CLAUDE_PLUGIN_OPTION_API_URL: `http://127.0.0.1:${slow.address().port}`, CLAUDE_PLUGIN_OPTION_TIMEOUT_MS: '700' }, /could not be reached/);
  assert.ok(Date.now() - started < 4000, 'the guard gives up quickly');
  slow.closeAllConnections(); slow.close();
  // Allowance used up: refused, and nothing is recorded.
  const row = await db()('usage_counters').where({ org_id: tenant.org.id }).first();
  await db()('usage_counters').where({ org_id: tenant.org.id }).update({ decisions: 100000 });
  await closed({}, /used all its policy decisions/);
  await db()('usage_counters').where({ org_id: tenant.org.id }).update({ decisions: row.decisions });
  // Explicit opt-outs.
  const down = { CLAUDE_PLUGIN_OPTION_API_URL: 'http://127.0.0.1:9', CLAUDE_PLUGIN_OPTION_TIMEOUT_MS: '1000' };
  const ask = await run('bash-test', { env: { ...down, CLAUDE_PLUGIN_OPTION_ON_ERROR: 'ask' } });
  assert.equal(ask.decision.permissionDecision, 'ask');
  assert.match(ask.decision.permissionDecisionReason, /Remus has not checked this call/);
  assert.deepEqual([(await run('bash-test', { env: { ...down, CLAUDE_PLUGIN_OPTION_ON_ERROR: 'pass' } })).stdout, (await run('bash-test', { env: { ...down, CLAUDE_PLUGIN_OPTION_ON_ERROR: 'whatever' } })).decision.permissionDecision], ['', 'deny']);
});

test('which tools are checked is configurable; unchecked tools cost no request', async () => {
  const count = await total();
  assert.deepEqual([(await run('read')).stdout, await total()], ['', count], 'Read is not checked by default');
  assert.deepEqual([(await run('bash-test', { env: { CLAUDE_PLUGIN_OPTION_TOOLS: 'Write,Edit' } })).stdout, await total()], ['', count]);
  assert.deepEqual([(await run('mcp-call', { env: { CLAUDE_PLUGIN_OPTION_SKIP_TOOLS: 'mcp__github__*' } })).stdout, await total()], ['', count]);
  // Opting Read in sends it to Remus, where the starter policy has no rule for it: default deny.
  const read = await run('read', { env: { CLAUDE_PLUGIN_OPTION_TOOLS: 'Read' } });
  assert.match(read.decision.permissionDecisionReason, /rule "default_deny"/);
  assert.deepEqual([(await latest()).action, (await latest()).resource], ['claude.read', 'README.md']);
  // REMUS_GUARD_* variables configure the guard outside the plugin system.
  const viaEnv = await run('bash-test', { env: { CLAUDE_PLUGIN_OPTION_ON_ALLOW: '', REMUS_GUARD_ON_ALLOW: 'approve' } });
  assert.equal(viaEnv.decision.permissionDecision, 'allow');
});

test('record_outcomes: the call is claimed before it runs and its outcome is reported afterwards', async () => {
  const env = { CLAUDE_PLUGIN_OPTION_RECORD_OUTCOMES: 'true' };
  const ok = await run('bash-test', { env });
  assert.equal(ok.stdout, '');
  const claimed = await latest();
  assert.deepEqual([claimed.status, claimed.execution.mode], ['executing', 'external']);
  await run({ ...ok.input, hook_event_name: 'PostToolUse', tool_response: { stdout: 'ok' } }, { env, mode: 'post-ok', keepId: true });
  assert.deepEqual([(await tenant.admin.getRequest(claimed.id)).status, (await tenant.admin.getRequest(claimed.id)).result.detail], ['executed', { tool: 'Bash' }]);
  const failing = await run('write-inside', { env });
  await run({ ...failing.input, hook_event_name: 'PostToolUseFailure' }, { env, mode: 'post-failed', keepId: true });
  assert.equal((await latest()).status, 'failed');
  assert.deepEqual((await tenant.agentClient.audit(claimed.id)).events.map(event => event.event), ['request_evaluated', 'execution_authorized', 'outcome_reported']);
  // Off by default: the post hook does nothing and makes no request.
  const count = await total();
  const quiet = await run('bash-test');
  const after = await run({ ...quiet.input, hook_event_name: 'PostToolUse' }, { mode: 'post-ok', keepId: true });
  assert.deepEqual([after.code, after.stdout, (await latest()).status, await total()], [0, '', 'ready', count + 1]);
  // A post hook never fails the session, even when Remus is down.
  assert.equal((await run('bash-test', { env: { ...env, CLAUDE_PLUGIN_OPTION_API_URL: 'http://127.0.0.1:9' }, mode: 'post-ok' })).code, 0);
});

test('what leaves the machine: preview, hash or none, and never the text of a secret-looking file', async () => {
  const project = '/home/dev/shop';
  const write = fixture('write-inside'); const edit = fixture('edit-outside'); const secret = fixture('write-env'); const mcp = fixture('mcp-call');
  const body = write.tool_input.content;
  // preview (default): clipped text plus size and hash.
  assert.deepEqual(Object.keys(describe(write, project).args).sort(), ['content_bytes', 'content_preview', 'content_sha256', 'extension', 'file_name', 'in_project', 'path']);
  assert.equal(describe(write, project).args.content_preview, body);
  // hash: size and hash only. none: neither.
  const hashed = describe(write, project, 'hash').args;
  assert.deepEqual([Object.keys(hashed).sort(), hashed.content_bytes], [['content_bytes', 'content_sha256', 'extension', 'file_name', 'in_project', 'path'], Buffer.byteLength(body)]);
  assert.deepEqual(Object.keys(describe(write, project, 'none').args).sort(), ['extension', 'file_name', 'in_project', 'path']);
  for (const mode of ['hash', 'none']) {
    const sent = JSON.stringify([describe(write, project, mode), describe(edit, project, mode), describe(mcp, project, mode)]);
    for (const text of ['reduce', 'export PATH=', '/tmp/bin', 'Cart total is wrong', 'Steps to reproduce']) assert.ok(!sent.includes(text), `${mode}: ${text}`);
  }
  assert.deepEqual(Object.keys(describe(edit, project, 'hash').args).filter(key => /^(old|new)_/.test(key)).sort(), ['new_bytes', 'new_sha256', 'old_bytes', 'old_sha256']);
  assert.deepEqual(describe(mcp, project, 'none').args, { keys: ['owner', 'repo', 'title', 'body'] });
  assert.deepEqual(Object.keys(describe(mcp, project, 'hash').args).sort(), ['input_bytes', 'input_sha256', 'keys']);
  // Secret-looking paths: hash only, even in preview mode, for writes and for edits.
  const env = describe(secret, project).args;
  assert.deepEqual([env.sensitive_path, env.content_preview, typeof env.content_sha256, env.content_bytes], [true, undefined, 'string', 27]);
  assert.ok(!JSON.stringify(describe(secret, project)).includes('sk_live_example'));
  const keyEdit = describe({ tool_name: 'Edit', cwd: project, tool_input: { file_path: '/home/dev/.ssh/config', old_string: 'IdentityFile old', new_string: 'IdentityFile new' } }, project);
  assert.ok(!JSON.stringify(keyEdit).includes('IdentityFile') && keyEdit.args.sensitive_path === true);
  assert.deepEqual(['.env', '.env.production', 'server.pem', 'tls.key', 'id_rsa', 'id_ed25519.pub', 'credentials', 'credentials.json', '.npmrc', '.netrc', 'api-token.txt', 'db_password.txt'].map(name => looksSecret(`/p/${name}`)), Array(12).fill(true));
  assert.deepEqual(['/p/.aws/config', '/p/.ssh/known_hosts', '/p/secrets/app.yaml', 'C:\\Users\\dev\\.ssh\\config'].map(looksSecret), [true, true, true, true]);
  assert.deepEqual(['/p/src/cart.js', '/p/README.md', '/p/environment.ts', '/p/keyboard.js', '/p/package.json'].map(looksSecret), [false, false, false, false, false]);
  // End to end: what Remus stored for a secret-looking write, and in hash mode.
  await run('write-env');
  const stored = await latest();
  assert.deepEqual([stored.rule, stored.args.sensitive_path, 'content_preview' in stored.args], ['protect_secrets_and_git', true, false]);
  assert.ok(!JSON.stringify(stored).includes('sk_live_example'));
  await run('write-inside', { env: { CLAUDE_PLUGIN_OPTION_CONTENT: 'hash' } });
  assert.ok(!JSON.stringify(await latest()).includes('reduce'));
  // An unrecognised setting sends nothing rather than everything.
  await run('write-inside', { env: { CLAUDE_PLUGIN_OPTION_CONTENT: 'everything' } });
  assert.deepEqual(Object.keys((await latest()).args).sort(), ['extension', 'file_name', 'in_project', 'path']);
});
