# Getting started: Claude Code under a Remus policy

About ten minutes. At the end, Claude Code's edits inside your project and ordinary shell commands go ahead as before, destructive commands wait for a reviewer, and a short list is refused outright.

## 1. Create the agent and its key

1. Sign up at https://app.remus.new-odyssey.com/signup and confirm your email. The Free plan (5,000 policy decisions a month) needs no card.
2. Open **Agents and keys**, register an agent named exactly `claude-code`, and create a key for it. Copy the key (`remus_agent_...`); it is shown once.

Use one agent per person or per machine if you want the decision history to say who ran what (`claude-code-alex`, `claude-code-ci`), and change `agents` in the policy to match (`claude-code*` matches them all).

## 2. Activate the starter policy

Until a policy is active, Remus denies every request, so the plugin would block every checked tool call.

1. Open **Policy**.
2. Replace the editor's contents with [`policies/claude-code-starter.json`](../policies/claude-code-starter.json).
3. Use the test panel to try it: agent `claude-code`, action `claude.bash`, resource `rm:.`, arguments `{ "command": "rm -rf build", "in_project": true }` should answer **needs approval** by rule `hold_recursive_delete`.
4. Choose **Save and activate**.

What the starter policy does:

| Effect | Applies to |
| --- | --- |
| **Allow** | Writes and edits inside the project; shell commands run from inside the project; web fetches |
| **Review** | Writes and shell commands outside the project; every MCP tool call; commands matching `rm -r`, `git push --force`, `git reset --hard`, `git clean`, `DROP TABLE` / `DROP DATABASE`, `terraform destroy`, `kubectl delete`, `npm publish`, `docker system prune`, and piping into `sh` or `bash` |
| **Deny** | Writing `.env` files, `*.pem`, `*.key`, SSH keys, `.git/`, `.ssh/`, `.aws/`; commands with `sudo`, `mkfs`, `dd ... of=/dev/...`, and the classic fork bomb |
| **Deny (default)** | Anything else the plugin checks |

Order does not matter in a Remus policy: deny beats review, which beats allow. So `sudo rm -rf build` is denied, `rm -rf build` waits for a reviewer, and `npm test` goes ahead.

Edit it to fit. Common changes:

- Trust an MCP server: add an allow rule for `claude.mcp.<server>.*` (or for single tools).
- Hold fewer commands: delete the `hold_*` rules you do not want.
- Add a team reviewer: give the `hold_*` rules an `approval` block with a `reviewerRole`.

Command patterns are plain text with `*` as the wildcard, and they are case-sensitive. They catch the obvious forms, not every way of writing a command.

## 3. Install the plugin and set the key

```sh
claude plugin marketplace add <owner>/remus-agent
claude plugin install remus@remus
```

Start Claude Code, run `/plugin`, open **remus** and paste the key into **Remus agent key**.

## 4. Check it

In a Claude Code session inside a project, ask for each of these:

| Ask Claude to | Expected |
| --- | --- |
| run `npm test` (or any harmless command) | Runs as usual, with Claude Code's normal permission prompt if you have not already allowed it |
| run `sudo ls` | Refused: Claude reports that Remus denied it by rule `deny_sudo` |
| run `rm -rf some-scratch-directory` | After the wait, you are asked, and the request appears in the Remus **Approvals** inbox |
| write a `.env` file | Refused by rule `protect_secrets_and_git` |

Then open **Decision history** in the dashboard: each call is there with the rule that decided it.

## 5. Approving a held call

A held call appears in **Approvals** with the command or the change, the working directory and the rule. A reviewer (a workspace admin or reviewer; developers cannot approve) approves or rejects that exact request.

- If the approval arrives while the plugin is still waiting, the call continues.
- If it arrives later, ask Claude to make the same call again: the plugin finds the approved request and continues without a second review. An approval can be used once and expires five minutes after it is given (the policy's `validForSeconds`).

## If every call is refused

| Claude reports | Cause |
| --- | --- |
| `rule "no_active_policy"` | No policy is active. Do step 2. |
| `rule "default_deny"` | No rule allows that action for this agent. Check the agent's name matches the policy's `agents`. |
| `No Remus agent key is configured` | Set the key in `/plugin`, or export `REMUS_AGENT_KEY`. |
| `Remus rejected the agent key` | The key was revoked or mistyped. Create a new one. |
| `Remus could not be reached` | Network or proxy. The guard fails closed; set **When Remus cannot decide** to `ask` if you prefer to be asked. |
| `used all its policy decisions` | The plan's monthly allowance is used up. |
