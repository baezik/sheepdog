# Sheepdog: notes for agents

Free, open-source (MIT) Mac menu bar app + local Node server. Public repo: https://github.com/Baezik/sheepdog.
Everything is generic: never hardcode a company, repo, host, IP, ticket prefix or person. All of that comes from the user's settings.

## Layout

- `server/`: Node server. One runtime dependency, `@anthropic-ai/sdk` (Herder), pinned in `package-lock.json`; `build.sh` runs `npm ci --omit=dev` and bundles `node_modules`. `public/`: board UI (plain JS, no build step). `test/`: `npm test`.
- `macos/`: Swift menu bar app. `build.sh` bundles Node + `server/` + `public/` + Sparkle into `Sheepdog.app`.
- The Mac app runs its **own copy** of `server/` and `public/` from inside the app bundle. After any code change, rebuild:
  quit Sheepdog (`osascript -e 'quit app "Sheepdog"'`), run `macos/build.sh`, then `open macos/build/Sheepdog.app`.

## Releasing a new version (what "ship it to the team" means)

```sh
cd macos && ./release.sh <version> "One change per line
Another change"
```

- Version: semver, higher than the latest release (`0.1.0` → `0.1.1` for fixes, `0.2.0` for features). The script refuses anything else.
- It runs the tests, sets `package.json`'s version, builds, signs the update with the Sparkle key, writes `appcast.xml` and creates GitHub release `v<version>` (DMG + zip + appcast) on `Baezik/sheepdog`.
- Installed apps check `releases/latest/download/appcast.xml` every 6 hours and show "Update to Sheepdog x.y.z…".
- Quit the running Sheepdog first: the build replaces `macos/build/`.
- Release notes are user-facing: plain language, what changed for the user, not implementation details.
- After a release, commit the version bump and push (see below).
- Check: `curl -sL https://github.com/Baezik/sheepdog/releases/latest/download/appcast.xml | grep sparkle:version`

## Git and GitHub: always as Baezik

This machine's active `gh` account is a work account. Sheepdog belongs to the personal account **Baezik**. Never push, release or open PRs from the work account, and never put the work email in commits.

- The local repo is set up with `user.name Baezik` and Baezik's GitHub no-reply email (`git config user.email`). Don't change them.
- Use Baezik's token for one command instead of switching accounts:
  - gh: `GH_TOKEN=$(gh auth token -u Baezik) gh …`
  - push: `GH_TOKEN=$(gh auth token -u Baezik) git -c credential.helper= -c "credential.helper=!f() { echo username=x-access-token; echo password=\$GH_TOKEN; }; f" push origin main`
- Commit straight to `main`. There's no PR flow for now.

## Before every push: nothing sensitive

The repo is public. Before pushing, scan what's staged and stop if anything real shows up:

```sh
git diff --cached --name-only | xargs grep -nIiE "xox[abpe]-[0-9a-z-]{10,}|ghp_[a-z0-9]{20,}|github_pat_|BEGIN [A-Z ]*PRIVATE|/Users/|@[a-z0-9-]+\.(no|com)\b"
```

- No tokens, keys, IPs, hostnames, real names, company names, Slack channel names or home paths. Use fake data in tests (`alice`, `acme`).
- GitHub push protection blocks token-shaped strings even when they're fake: build fake tokens at runtime (e.g. `['xoxp', '123', …].join('-')`).
- User settings live in `~/.config/sheepdog/` and are never in the repo.

## Update signing key (Sparkle)

- The private EdDSA key is in the login Keychain (account `sheepdog`); `release.sh` uses it automatically. A backup lives outside the repo.
- Never commit the private key. The public half is `SUPublicEDKey` in `macos/Info.plist`. Don't change it, or installed copies will reject every future update.
