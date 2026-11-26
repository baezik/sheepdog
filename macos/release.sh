#!/bin/bash
# Publishes a new Sheepdog version. Everyone running Sheepdog gets "Update to Sheepdog <version>…" within
# a few hours (or right away with Check for Updates…).
#
#   ./release.sh 0.1.1 "Newest PRs first
#   Approved PRs leave the sidebar"          one change per line; shown in the update window
#
# What it does: runs the tests, sets the version in package.json, builds (./build.sh), signs the update
# with the Sparkle key in your Keychain (account "sheepdog"), writes appcast.xml and creates the GitHub
# release v<version> on $REPO with the DMG (first installs), the zip (updates) and appcast.xml.
# Installed apps read releases/latest/download/appcast.xml, so the newest release is always the feed.
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$(cd .. && pwd)"
REPO="${REPO:-Baezik/sheepdog}"
OWNER="${REPO%%/*}"
die() { echo "✗ $*" >&2; exit 1; }

NEW="${1:-}"
NOTES="${2:-}"
[[ "$NEW" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "usage: ./release.sh <version like 0.1.1> \"release notes, one change per line\""

# publish as the repo owner without switching your active gh account
GH_TOKEN="$(gh auth token -u "$OWNER" 2>/dev/null)" || die "log in to GitHub as $OWNER first: gh auth login"
export GH_TOKEN

LATEST="$(gh release view --repo "$REPO" --json tagName -q .tagName 2>/dev/null || true)"
LATEST="${LATEST#v}"
if [ -n "$LATEST" ]; then
  [ "$LATEST" != "$NEW" ] && [ "$(printf '%s\n%s\n' "$LATEST" "$NEW" | sort -V | tail -1)" = "$NEW" ] \
    || die "version must be higher than the latest release ($LATEST)"
fi
echo "› Releasing Sheepdog $NEW to $REPO (latest: ${LATEST:-none})"

echo "› Tests"
(cd "$ROOT" && npm test >/dev/null) || die "tests failed (run npm test in $ROOT)"

sed -i '' -E "1,/\"version\"/ s/\"version\": *\"[^\"]*\"/\"version\": \"$NEW\"/" "$ROOT/package.json"
VERSION="$NEW" ./build.sh

STAGE="build/release"
rm -rf "$STAGE"
mkdir -p "$STAGE"
cp "build/Sheepdog-$NEW.zip" "$STAGE/"
if [ -n "$NOTES" ]; then
  # release notes for the update window: one <li> per line
  python3 - "$NOTES" > "$STAGE/Sheepdog-$NEW.html" <<'PY'
import html, sys
lines = [l.strip(" -•\t") for l in sys.argv[1].splitlines() if l.strip()]
print("<ul>" + "".join(f"<li>{html.escape(l)}</li>" for l in lines) + "</ul>")
PY
fi

echo "› Signing the update and writing appcast.xml"
vendor/sparkle/bin/generate_appcast --account sheepdog --embed-release-notes \
  --download-url-prefix "https://github.com/$REPO/releases/download/v$NEW/" \
  --link "https://github.com/$REPO" -o "$STAGE/appcast.xml" "$STAGE"
grep -q "sparkle:edSignature" "$STAGE/appcast.xml" || die "appcast has no signature; is the Sparkle key in your Keychain?"

echo "› Publishing the GitHub release"
gh release create "v$NEW" --repo "$REPO" --title "Sheepdog $NEW" \
  --notes "${NOTES:-Sheepdog $NEW}

**New install:** download \`Sheepdog-$NEW.dmg\`, drag Sheepdog to Applications, then right-click it › Open the first time.
**Already installed:** Sheepdog updates itself (menu bar › Check for Updates…)." \
  "build/Sheepdog-$NEW.dmg" "$STAGE/Sheepdog-$NEW.zip" "$STAGE/appcast.xml"

echo "✓ https://github.com/$REPO/releases/tag/v$NEW"
