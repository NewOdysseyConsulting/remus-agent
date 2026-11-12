# Publishing

Nothing in this repository or in the Remus CLI has been published. This is the order to do it in, with the exact commands. Steps marked **(account)** need you to be signed in to that service.

Before starting, decide two things and apply them:

1. **Where this repository lives.** The install commands in `README.md` and `docs/GETTING-STARTED.md` say `<owner>/remus-agent`. Replace `<owner>` with the GitHub organisation or user, and add `"repository": "https://github.com/<owner>/remus-agent"` to `.claude-plugin/plugin.json`.
2. **The ClawHub publisher handle.** Replace `@<owner>/remus` in `README.md` with it.

The marketplace is named `remus` and the plugin is named `remus`, so users install `remus@remus`. Both names are permanent once people have installed.

## 1. Deploy the service change **(account: Render)**

The CLI's `history` command with an agent key relies on a small API change on the Remus repository's `agent-tools` branch (`GET /v1/requests` now lets an agent key list its own agent's requests). Merge `agent-tools` into `main` and let `remus-app` deploy before publishing the CLI. Until then `remus history` answers `forbidden` for agent keys; every other command works against the live service as it is.

The same merge publishes the CLI docs page (`/docs/cli`) and the tarball at `https://remus.new-odyssey.com/downloads/remus-cli.tgz`.

## 2. Publish the CLI to npm **(account: npm, with rights to the `@new-odyssey` scope)**

The skill's install metadata names the npm package `@new-odyssey/remus-cli`, so this comes before ClawHub.

```sh
cd Remus/cli
npm test                         # needs the throwaway Postgres from Remus/service/README.md
npm pack --dry-run               # check the file list: bin/, lib/, README.md, LICENSE, package.json
npm login                        # if not already signed in
npm publish --access public
npm view @new-odyssey/remus-cli version    # 1.0.0
npm install -g @new-odyssey/remus-cli && remus help
```

If the `@new-odyssey` scope does not exist on npm yet, create the organisation first at https://www.npmjs.com/org/create (the scope name is `new-odyssey`). The unscoped name `remus` belongs to an unrelated package; do not use it.

After publishing, change the install lines to the registry form (`npm install -g @new-odyssey/remus-cli`) in `Remus/cli/README.md`, in `cliInstallCommand` in `Remus/landing/app/preview-content.js`, and in the "Install" section of the CLI guide in `Remus/landing/app/docs/guides.js`, which currently says the tool is not on the npm registry.

Optional, same account: publish the SDK too (`cd Remus/service/sdk && npm publish --access public`) and update the SDK install line in the docs.

## 3. Push this repository **(account: GitHub)**

```sh
cd remus-agent
npm test && npm run validate     # 10 tests; "Validation passed"
gh repo create <owner>/remus-agent --public --source . --remote origin --description "Remus agent skill and Claude Code plugin"
git push -u origin main
```

A public repository is what makes the plugin installable by anyone. A private one limits it to people who can clone it.

## 4. Claude Code plugin

Once the repository is pushed, the plugin is published: the repository is its own marketplace (`.claude-plugin/marketplace.json` lists the plugin with `"source": "./"`). Check it as a user would:

```sh
claude plugin marketplace add <owner>/remus-agent
claude plugin install remus@remus
claude plugin list               # remus@remus, enabled
```

Then in a session: `/plugin` → **remus** → set **Remus agent key**, and run the checks in `docs/GETTING-STARTED.md` step 4.

To release a new version: change `version` in `.claude-plugin/plugin.json`, commit and push. Users get it with `claude plugin update remus@remus`. If the version is not changed, users keep the old copy.

To try it without publishing: `claude --plugin-dir /path/to/remus-agent`.

### Anthropic's plugin directory (optional) **(account: paid claude.ai plan)**

```sh
claude plugin validate . --profile directory     # the directory's own pre-checks; currently clean
```

Submit from https://claude.ai/directory/manage, following https://claude.com/docs/plugins/submit . The portal applies rules the CLI does not check, and runs a safety scan and a policy review. Hooks are a Claude Code component: check the component support table linked from the submission page for what loads on claude.ai and in Cowork. The directory listing reads `icon` (`.claude-plugin/icon.png` is in place) and, if you add them to `plugin.json`, `documentationUrl`, `supportUrl`, `privacyPolicyUrl` and `termsOfServiceUrl`; the last two need pages that do not exist on the Remus site yet.

## 5. ClawHub skill **(account: ClawHub)**

ClawHub licenses every skill under MIT-0; this repository is MIT-0 throughout, so nothing conflicts.

```sh
npm i -g clawhub                 # if not installed
clawhub login                    # opens a browser to approve a one-time code
clawhub whoami

cd remus-agent
clawhub skill publish ./skills/remus --slug remus --name "Remus" --dry-run
clawhub skill publish ./skills/remus --slug remus --name "Remus" \
  --topics "permissions,approvals,policy,security,audit" \
  --changelog "First release."
clawhub inspect @<handle>/remus
```

- Add `--owner <handle>` to both publish commands to publish under an organisation handle instead of your own.
- `--categories` takes ClawHub's category slugs. The dry run does not check them, so pick one from the site before adding the flag.
- A new skill is published as 1.0.0. Later publishes take the next patch version automatically; pass `--version` to choose.
- The release stays out of search and install until ClawHub's security checks pass. The skill declares the `remus` binary and the `REMUS_AGENT_KEY`, `REMUS_API_URL` and `REMUS_TIMEOUT_MS` variables; ClawHub flags a mismatch if the instructions mention a variable that is not declared, so declare any you add.
- If the slug `remus` is taken, choose another slug; the folder and the `name` in the frontmatter can stay.

## 6. Afterwards

- Add a section to the CLI guide on the Remus site pointing at the plugin and the skill (it was left out because neither was published).
- Add `https://github.com/<owner>/remus-agent` to the Remus docs wherever Claude Code or agent skills are mentioned.
