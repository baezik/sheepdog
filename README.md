# Sheepdog

Watches Claude Code and Codex on your computer and your other machines, and tells you the moment one is waiting for you. Amber is reserved for "your turn".

- **Board**: one card per agent: your turn (amber, sorted first), working (green), idle (grey, after 30 min unanswered). Cards show the ticket, title, last prompt, machine, context % and tokens. Click a card to jump to its terminal tab (cmux or iTerm2).
- **PR sidebar**: pull requests posted in a Slack channel you pick. Newest post first, refreshed every 10 seconds. 👀 = someone is reviewing. PRs leave once approved (✅ in Slack or approved on GitHub), merged or closed.
- **Branches**: last merge per repository on the branches you track (e.g. dev / staging / main), with CI and deploy status.
- **Stats**: agent time per day or hour, when your agents work (weekday × hour), how fast you answer waiting agents, how many run in parallel, tokens by ticket / repository / model, and PR review times (until someone reviews, until approved, who reviews most).
- **Alerts**: notification, sound (Woof / Ding / Bleat / Silent), window flash, quiet hours. PR alerts too: someone started reviewing your PR, your PR was approved, a teammate's PR has had no reviewer for hours (click to open the PR).

Free and open source (MIT).

## Install

1. Download `Sheepdog-<version>.dmg` from the [latest release](https://github.com/Baezik/sheepdog/releases/latest).
2. Open it and drag **Sheepdog** into **Applications**.
3. The first time, **right-click Sheepdog › Open** and confirm. Sheepdog isn't notarized by Apple, so a plain double-click is blocked once.
4. Follow the setup wizard.

Needs macOS 13 or later on an Apple silicon Mac.

**Updates:** Sheepdog updates itself. When a new version is out, the 🐶 gets a dot and the menu shows **Update to Sheepdog x.y.z…**; **Check for Updates…** checks right away. Your settings are kept.

## Build the Mac app

```sh
cd macos && ./build.sh      # → macos/build/Sheepdog.app, Sheepdog-<version>.dmg and .zip
```

Needs Xcode or the Command Line Tools (Swift 5.9+) and Node 20+ (the Node you build with is bundled into the app). The first build downloads [Sparkle](https://sparkle-project.org) (the updater, MIT) into `macos/vendor/` and checks its checksum.

A menu bar app (Swift/AppKit, macOS 13+) that carries its own Node runtime and the server/UI, so users install nothing else. The 🐶 shows an amber count when agents wait, `ᶻ` when nothing needs you, a red `⧗n` when a machine is overloaded, and barks when a new agent turns amber. The dropdown lists agents grouped as Your turn / Working / Idle (click one to jump to its tab), plus Open Board ⌘B, Settings…, Run Setup Again…, Open at Login and Quit. The board, settings and setup wizard open in a native window; notifications are native, with a Jump to Tab action.

Builds are ad-hoc signed for now: the first time, right-click Sheepdog › Open (or System Settings › Privacy & Security › Open Anyway). For public downloads, build with `SIGN_ID="Developer ID Application: …"`, then notarize and staple the DMG (`xcrun notarytool submit … --wait`, `xcrun stapler staple`). The bundle is Apple-silicon only until a universal Node runtime is bundled. Server log: `~/Library/Logs/Sheepdog/server.log`.

### Releasing (maintainers)

```sh
cd macos && ./release.sh 0.1.1 "Newest PRs first
Approved PRs leave the sidebar"
```

Runs the tests, sets the version, builds, signs the update with the Sparkle EdDSA key in your login Keychain (account `sheepdog`, create it once with `vendor/sparkle/bin/generate_keys --account sheepdog`), and publishes GitHub release `v<version>` with the DMG, the update zip and `appcast.xml`. Installed apps read `releases/latest/download/appcast.xml` every 6 hours. Keep a backup of the private key (`generate_keys --account sheepdog -x <file>`): without it, installed copies can't verify new versions. Forks that publish their own builds must change `SUPublicEDKey` in `macos/Info.plist` and `FEED_URL`/`REPO` in the scripts.

On a Mac, agents on this computer are read with Python 3 from Apple's Command Line Tools (installed with git / Xcode) or Homebrew. Without it, Sheepdog says so in setup instead of triggering the install pop-up.

## Run without the app

Needs Node 20+ and Python 3.8+ (on every watched machine).

```sh
npm start            # starts on http://127.0.0.1:4848 and opens the browser
npm start -- --no-open
SHEEPDOG_PORT=5000 npm start
npm test
```

The first run opens the setup wizard: detect agents here → pick SSH machines → terminal permissions → GitHub → Slack → alerts. Everything can be changed later in Settings (⌘,).

## Connections

**Machines**: any host in `~/.ssh/config`, or `user@host`. Needs key-based SSH (no password prompt) and `python3`. Sheepdog pipes a small read-only script (`server/probe.py`) over SSH each poll; nothing is installed there.

**GitHub**: three options:
1. *GitHub CLI*: reuses `gh auth login`; Sheepdog stores no token.
2. *Personal access token*: `repo` + `read:org` (classic), or a fine-grained token with read access to contents, pull requests, deployments and commit statuses.
3. *Sign in with GitHub*: OAuth device flow. Needs an OAuth app with Device Flow enabled; set its client ID in Settings › GitHub or ship it with `SHEEPDOG_GITHUB_CLIENT_ID`.

**Slack**, two ways:
1. *Team bot (recommended for teams):* one person clicks *Create the Sheepdog bot* in Settings › Slack (a bot-only app: no user permissions), installs it, types `/invite @Sheepdog` in the review channel, and shares the *Bot User OAuth Token* (`xoxb-`) with the team through a password manager. Everyone pastes it, picks the channel, and picks themselves from the channel's members. The bot reads messages and reactions only in channels it's invited to; like any workspace member it can also see channel names and the member directory (no emails). Disconnecting never revokes a shared bot token.
2. *Personal app:* create the app from the personal manifest and paste its *User OAuth Token* (`xoxp-`). It reads with your own access (every channel you're in), so prefer the bot. Disconnecting, or switching to a bot token, revokes the personal token in Slack.

Scopes (read-only): `channels:history`, `groups:history`, `channels:read`, `groups:read`, `reactions:read`, `users:read`.

## Privacy and security

- Listens on `127.0.0.1` only; rejects other Host headers (DNS rebinding) and cross-site writes.
- Settings and tokens live in `~/.config/sheepdog/config.json` (mode 600). The browser never receives tokens.
- Statistics history lives in `~/.config/sheepdog/history/` (one small file per day, deleted after 90 days, never uploaded). Settings › Advanced › Clear statistics deletes it.
- Jump-to-tab only reads tab titles/ttys and selects tabs; it never types into or reads a session.

## Layout

```
macos/                menu bar app (Swift), build.sh (.app/.dmg/.zip), release.sh
bin/sheepdog.mjs      start + open browser
server/index.mjs      HTTP server, routes, poll loops
server/config.mjs     settings file, validation, redaction
server/hosts.mjs      local + SSH probing, ~/.ssh/config, Codex terminal mapping
server/probe.py       runs on each machine; lists agents, context, tokens, load
server/terminal.mjs   cmux / iTerm2 tab mapping and focus
server/github.mjs     auth (gh / token / device flow), repos, branches, PR state
server/slack.mjs      auth, channel picker, PR sidebar from reactions, PR alerts
server/history.mjs    statistics history (samples, answers, PR timelines) and the numbers behind 📊 Stats
public/               board, settings, setup wizard (no build step)
test/                 node:test, no network
```

## Known limits

- Slack doesn't record *when* a reaction was added, so "reviewing since" is when Sheepdog first saw the 👀. The same goes for review times in Stats.
- Stats count time only while Sheepdog runs (one sample a minute).
- Claude logs don't record the context window size: 200k is assumed unless the session has gone past it (then 1M). Override with `CLAUDE_CONTEXT_WINDOW`.
- "⧗ queue" is the 1-minute load average minus the CPU count.
- macOS-first: jump-to-tab needs macOS; the board and probes also work on Linux.
- Not yet: Developer ID signing + notarization, universal (Intel) build.

## License

MIT, see [LICENSE](LICENSE). Bundles [Sparkle](https://github.com/sparkle-project/Sparkle) (MIT) and the [Node.js](https://nodejs.org) runtime (MIT).
