# Remus for agents

[Remus](https://remus.new-odyssey.com) is a permission service for AI agent tools: every action is checked against your policy and answered with **allow**, **deny** or **review** (held for a person's approval), and every decision is recorded.

This repository holds two ways to put an agent under a Remus policy:

| | What it is | Where it runs |
| --- | --- | --- |
| **Claude Code plugin** | A `PreToolUse` hook that asks Remus before Claude Code runs a shell command, writes or edits a file, fetches a URL or calls an MCP tool | Claude Code |
| **Agent skill** (`skills/remus`) | Instructions that teach an agent to ask Remus before it acts, using the `remus` command-line tool | OpenClaw (through ClawHub) and any agent that loads Agent Skills, including Claude Code |

The plugin **enforces**: the hook runs outside the model, so a denied call does not run whatever the model wants. The skill **instructs**: it relies on the agent following it, and suits actions that are not tool calls in themselves (a refund through your own API, a deployment script).

You need a Remus workspace (free plan: 5,000 policy decisions a month), an agent with a key, and an active policy. **With no active policy Remus denies everything**, so start with [docs/GETTING-STARTED.md](docs/GETTING-STARTED.md) and the starter policy in [`policies/claude-code-starter.json`](policies/claude-code-starter.json).

## Claude Code plugin

Requires Claude Code v2.1.295 or later and Node.js 20 or later on your `PATH`.

```sh
claude plugin marketplace add <owner>/remus-agent
claude plugin install remus@remus
```

Then set the agent key: run `/plugin` in a session, open **remus**, and paste the key into **Remus agent key**. It is stored in your system's credential store. Alternatively export `REMUS_AGENT_KEY` before starting Claude Code.

### What happens on each tool call

| Remus says | The plugin does |
| --- | --- |
| **deny** | Denies the call. Claude is told which rule refused it and not to look for a way round. |
| **review** | Waits up to 60 seconds for a reviewer. Approved: the call continues, and the approval is used up. Rejected: denied. No answer in time: the call is denied and Claude is told it is waiting for approval. When Claude makes the same call again later, the plugin continues with the same held request rather than asking the reviewer twice. The person at the keyboard cannot wave a held call through, unless you set **When no reviewer answers in time** to `ask`. |
| **allow** | Nothing. Claude Code's own permission flow decides as usual, so the plugin never widens what Claude Code would allow. Set **When Remus allows a call** to `approve` if you want Remus's allow to skip Claude Code's prompt. |
| nothing (unreachable, no key, key rejected, allowance used up) | Denies the call: the guard fails closed. Set **When Remus cannot decide** to `ask` or `pass` to change that. |

Your Claude Code deny and ask rules still apply whatever Remus says.

### What Remus sees

Each checked call becomes one request from the agent that owns the key:

| Tool | `action` | `resource` | `args` |
| --- | --- | --- | --- |
| Bash | `claude.bash` | `<program>:<working directory>`, e.g. `git:.` | `command`, `program`, `cwd`, `in_project`, `background` |
| Write, Edit, MultiEdit, NotebookEdit | `claude.write`, `claude.edit`, `claude.multi_edit`, `claude.notebook_edit` | the file path, relative to the project when inside it | `path`, `in_project`, `file_name`, `extension`, `sensitive_path` when the path looks like a secret, and the change as set by `content` (see below) |
| WebFetch | `claude.web_fetch` | the URL without its fragment | `url`, `host` |
| MCP tools | `claude.mcp.<server>.<tool>` | `<server>/<tool>` | the tool input as set by `content` (see below) |

Policies match on these. For example, `{ "arg": "in_project", "op": "eq", "value": true }` limits a rule to the project, and `{ "arg": "command", "op": "glob", "value": "*git push*--force*" }` matches a command. Command matching is text matching, not shell parsing: treat it as a seatbelt, and keep Claude Code's own permissions in place.

### What leaves your machine

Every checked call sends the tool name (as the action), the resource and the agent's identity (the key). Beyond that:

| | `content: preview` (default) | `content: hash` | `content: none` |
| --- | --- | --- | --- |
| **Shell command** | The command text (up to 8,000 characters), the working directory and Claude's one-line description of the command | same | same |
| **File path** | The path, relative to the project when inside it, otherwise absolute | same | same |
| **Write** | Size, SHA-256 and the first 2,000 characters of the content | Size and SHA-256 | Nothing about the content |
| **Edit** | Size, SHA-256 and the first 2,000 characters of the old text and of the new text | Size and SHA-256 of each | Nothing about the content |
| **WebFetch** | The URL | same | same |
| **MCP tool input** | The input, with each string clipped to 1,000 characters; a digest instead if it is larger than 12 KB | Field names, size and SHA-256 | Field names only |

Files that look like secrets are never sent as text, in any mode: for those, `preview` behaves as `hash`. That covers `.env` and `.env.*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.jks`, `*.keystore`, `*.kdbx`, `*.asc`, `*.gpg`, `id_rsa*`, `id_dsa*`, `id_ecdsa*`, `id_ed25519*`, `credentials*`, `.netrc`, `.npmrc`, `.pypirc`, `.pgpass`, `.htpasswd`, any file whose name contains `secret`, `password`, `passwd` or `token`, and anything under `.ssh/`, `.aws/`, `.gnupg/`, `.kube/`, `.docker/` or `secrets/`. The test is on the path only; it does not read the content.

Not covered by `content`: shell commands and URLs are always sent in full, because the policy matches on them. A secret typed into a command line or a URL reaches Remus and its decision history. Tool results are never sent.

What is sent is stored with the request in your Remus workspace for the plan's history period, shown to reviewers on the approval page, and included in webhook events. Use `hash` or `none` if file content should not be stored there; reviewers then judge by path and look at the diff in the session.

### Options

Set these in `/plugin` → **remus**, or as `REMUS_GUARD_<NAME>` environment variables.

| Option | Default | Meaning |
| --- | --- | --- |
| `agent_key` | `REMUS_AGENT_KEY` | The agent key. |
| `api_url` | `https://api.remus.new-odyssey.com` | Must be https, except for localhost. |
| `on_allow` | `prompt` | `prompt`: Claude Code's permission flow still applies. `approve`: Remus's allow approves the call. |
| `review_wait_seconds` | `60` | How long to wait for a reviewer (0 to 300). |
| `on_review_timeout` | `deny` | `deny`: refuse and wait for the reviewer. `ask`: ask the person at the keyboard, who can then override the review for that one call. |
| `content` | `preview` | How much file content and MCP input is sent: `preview`, `hash` or `none`. See "What leaves your machine". |
| `on_error` | `deny` | `deny`, `ask` or `pass` when Remus cannot decide. |
| `tools` | `Bash,Write,Edit,MultiEdit,NotebookEdit,WebFetch,mcp__*` | Tool names to check; `*` is a wildcard. |
| `skip_tools` | empty | Tool names to leave unchecked, e.g. `mcp__ide__*`. |
| `record_outcomes` | `false` | Claim each allowed call in Remus and report whether it succeeded. Uses a second policy decision per call. |
| `timeout_ms` | `4000` | Timeout for each request to Remus. |

The hook is registered for Bash, Write, Edit, MultiEdit, NotebookEdit, WebFetch, WebSearch and every MCP tool. `tools` narrows that list. To check a tool outside it (for example `Read`), add a hook of your own in `settings.json` that runs the same script, and include the tool in `tools`:

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Read|Glob|Grep", "hooks": [{ "type": "command", "command": "node", "args": ["/path/to/remus-agent/scripts/guard.mjs", "pre"], "onFailure": "block" }] }
    ]
  }
}
```

### Cost and speed

One request to Remus per checked tool call, with a 4-second timeout. Each uses one policy decision from your plan. A call that goes through review, or any call with `record_outcomes` on, uses a second one.

### Limits

- The guard checks tool calls Claude Code makes. It cannot see what a command does once it runs, so a script the policy allows can still do anything the script does.
- `on_review_timeout: ask` lets the person at the keyboard override a review. Leave it at `deny` when the reviewer must be someone else.
- An unrecognised value for an option is treated as the strictest one (`on_allow: prompt`, `on_review_timeout: deny`, `on_error: deny`, `content: none`).
- If the hook process itself cannot start (Node.js missing), Claude Code blocks the call (`onFailure: block`, v2.1.295 or later). On older versions a hook that fails to start does not block.

## Agent skill

[`skills/remus/SKILL.md`](skills/remus/SKILL.md) tells an agent when to ask Remus and exactly what to do on allow, deny, review and error. It needs the `remus` command and `REMUS_AGENT_KEY`.

```sh
npm install -g @new-odyssey/remus-cli
clawhub install @<owner>/remus
```

For Claude Code, installing the plugin above also loads the skill.

## Development

```sh
npm test            # guard tests: recorded hook inputs against the Remus service code, in-process
npm run validate    # claude plugin validate . --strict
```

The tests import the service from a sibling checkout of the Remus repository (`../Remus/service`, or `REMUS_SERVICE_DIR`) and need the throwaway Postgres its README describes.

`scripts/guard.mjs` is one file with no dependencies. Publishing steps are in [PUBLISHING.md](PUBLISHING.md).

Licence: MIT-0.
