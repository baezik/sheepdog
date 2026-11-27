#!/bin/bash
# Builds Sheepdog.app and Sheepdog-<version>.dmg into macos/build/.
#
#   ./build.sh                      ad-hoc signed (for testing; right-click › Open the first time)
#   SIGN_ID="Developer ID Application: …" ./build.sh   signed for distribution (notarize afterwards)
#   NODE_BIN=/path/to/node ./build.sh                  bundle a specific Node binary
#   VERSION=0.0.1 ./build.sh                           override package.json's version (testing updates)
#
# Updates: the app checks FEED_URL (the appcast.xml on the latest GitHub release) with Sparkle.
# Publish a new version with ./release.sh, not by hand.
#
# The app carries its own Node runtime and the server/UI files, so users install nothing else.
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$(cd .. && pwd)"
OUT="$PWD/build"
APP="$OUT/Sheepdog.app"
VERSION="${VERSION:-$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$ROOT/package.json" | head -1)}"
# Sparkle compares CFBundleVersion, so it is the version itself (not a timestamp)
BUILD_NUM="$VERSION"
FEED_URL="${FEED_URL:-https://github.com/Baezik/sheepdog/releases/latest/download/appcast.xml}"
SPARKLE_VERSION="2.10.1"
SPARKLE_SHA256="1a856d2a9edb8e628de88121d7be04cf0e2167f8641650b78fca00b14244cf27"
SPARKLE="$PWD/vendor/sparkle/Sparkle.framework"
if [ ! -d "$SPARKLE" ]; then
  echo "› Downloading Sparkle $SPARKLE_VERSION (the updater)"
  mkdir -p vendor/sparkle
  TAR="vendor/sparkle/sparkle.tar.xz"
  curl -fsSL -o "$TAR" "https://github.com/sparkle-project/Sparkle/releases/download/$SPARKLE_VERSION/Sparkle-$SPARKLE_VERSION.tar.xz"
  echo "$SPARKLE_SHA256  $TAR" | shasum -a 256 -c --quiet || { rm -f "$TAR"; echo "Sparkle download failed its checksum" >&2; exit 1; }
  tar -xf "$TAR" -C vendor/sparkle && rm "$TAR"
fi
NODE_BIN="${NODE_BIN:-$(command -v node)}"
SIGN_ID="${SIGN_ID:--}"

echo "› Sheepdog $VERSION ($BUILD_NUM)"
[ -x "$NODE_BIN" ] || { echo "Node not found; set NODE_BIN" >&2; exit 1; }
NODE_REAL="$(python3 -c 'import os,sys;print(os.path.realpath(sys.argv[1]))' "$NODE_BIN" 2>/dev/null || echo "$NODE_BIN")"
echo "› Node runtime: $NODE_REAL ($("$NODE_REAL" --version), $(lipo -archs "$NODE_REAL"))"

echo "› Compiling the app"
swift build -c release

echo "› Assembling Sheepdog.app"
rm -rf "$OUT"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/app" "$APP/Contents/Resources/runtime" "$APP/Contents/Frameworks"
cp .build/release/Sheepdog "$APP/Contents/MacOS/Sheepdog"
sed -e "s/__VERSION__/$VERSION/" -e "s/__BUILD__/$BUILD_NUM/" -e "s#__FEED_URL__#$FEED_URL#" Info.plist > "$APP/Contents/Info.plist"
ditto "$SPARKLE" "$APP/Contents/Frameworks/Sparkle.framework"
# runtime dependencies (the Anthropic SDK for Herder), exactly as locked
(cd "$ROOT" && npm ci --omit=dev --no-audit --no-fund >/dev/null)
cp -R "$ROOT/server" "$ROOT/public" "$ROOT/package.json" "$ROOT/node_modules" "$APP/Contents/Resources/app/"
find "$APP/Contents/Resources/app" -name '__pycache__' -prune -exec rm -rf {} +
cp "$NODE_REAL" "$APP/Contents/Resources/runtime/node"
chmod 755 "$APP/Contents/Resources/runtime/node"

echo "› Icon"
swift scripts/make-icon.swift "$OUT/AppIcon.iconset" >/dev/null
iconutil -c icns "$OUT/AppIcon.iconset" -o "$APP/Contents/Resources/AppIcon.icns"
rm -rf "$OUT/AppIcon.iconset"

echo "› Signing ($([ "$SIGN_ID" = "-" ] && echo "ad-hoc, not for distribution" || echo "$SIGN_ID"))"
OPTS=(--force --sign "$SIGN_ID")
if [ "$SIGN_ID" != "-" ]; then OPTS+=(--options runtime --timestamp); fi
# Node needs JIT under the hardened runtime
codesign "${OPTS[@]}" --entitlements node.entitlements "$APP/Contents/Resources/runtime/node"
# Sparkle ships signed by its developers; re-sign its parts (inside out) only for a real identity
if [ "$SIGN_ID" != "-" ]; then
  FW="$APP/Contents/Frameworks/Sparkle.framework"
  codesign "${OPTS[@]}" "$FW/Versions/B/XPCServices/Installer.xpc"
  codesign "${OPTS[@]}" --preserve-metadata=entitlements "$FW/Versions/B/XPCServices/Downloader.xpc"
  codesign "${OPTS[@]}" "$FW/Versions/B/Autoupdate"
  codesign "${OPTS[@]}" "$FW/Versions/B/Updater.app"
  codesign "${OPTS[@]}" "$FW"
fi
codesign "${OPTS[@]}" "$APP"
codesign --verify --deep --strict "$APP"

echo "› DMG"
STAGE="$OUT/dmg"
mkdir -p "$STAGE"
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
DMG="$OUT/Sheepdog-$VERSION.dmg"
hdiutil create -quiet -volname "Sheepdog" -srcfolder "$STAGE" -ov -format UDZO "$DMG"
rm -rf "$STAGE"
[ "$SIGN_ID" != "-" ] && codesign --force --sign "$SIGN_ID" "$DMG"

echo "✓ $APP"
echo "› Update archive"
ZIP="$OUT/Sheepdog-$VERSION.zip"
ditto -c -k --sequesterRsrc --keepParent "$APP" "$ZIP"

echo "✓ $DMG ($(du -h "$DMG" | cut -f1))"
echo "✓ $ZIP ($(du -h "$ZIP" | cut -f1))"
