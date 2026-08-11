#!/usr/bin/env bash
# Bump the Homebrew formula to a published version.
#
# The release workflow does this automatically, but only when the TAP_TOKEN
# secret exists (a PAT with contents:write on singhharsh1708/homebrew-tap).
# Until it does, the homebrew job skips with a warning and the bump falls to a
# human — which historically meant copying a sha256 by hand, once per release.
# This runs the same steps the workflow does, so the digest is never retyped.
#
#   scripts/bump-tap.sh 0.22.0          # show what would change, touch nothing
#   scripts/bump-tap.sh 0.22.0 --push   # commit and push it
#
# Dry run is the default on purpose: this pushes to a separate public repo, and
# a wrong digest there breaks `brew install` for everyone until it is noticed.
set -euo pipefail

VERSION="${1:-}"
PUSH="${2:-}"
TAP_REPO="singhharsh1708/homebrew-tap"

if [ -z "$VERSION" ]; then
  echo "usage: scripts/bump-tap.sh <version> [--push]" >&2
  exit 2
fi
if ! printf '%s' "$VERSION" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo "error: '$VERSION' is not a semver version (expected e.g. 0.22.0)" >&2
  exit 2
fi

# Refuse to point the formula at something nobody can install.
published=$(npm view "kitbash@${VERSION}" version 2>/dev/null || true)
if [ "$published" != "$VERSION" ]; then
  echo "error: kitbash@${VERSION} is not on npm yet — publish first, or the formula will 404" >&2
  exit 1
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

url="https://registry.npmjs.org/kitbash/-/kitbash-${VERSION}.tgz"
# The tarball can lag the publish by a few seconds on the CDN, same as in CI.
for i in 1 2 3 4 5; do
  if curl -fsSL "$url" -o "$work/kitbash.tgz"; then break; fi
  echo "tarball not on the registry yet, retrying ($i/5)"
  sleep 10
done
[ -s "$work/kitbash.tgz" ] || { echo "error: could not download $url" >&2; exit 1; }

# shasum on macOS, sha256sum on Linux — this script runs on a maintainer laptop.
if command -v sha256sum >/dev/null 2>&1; then
  sha=$(sha256sum "$work/kitbash.tgz" | cut -d' ' -f1)
else
  sha=$(shasum -a 256 "$work/kitbash.tgz" | cut -d' ' -f1)
fi

GIT_ASKPASS= git -c credential.helper='!gh auth git-credential' \
  clone -q "https://github.com/${TAP_REPO}.git" "$work/tap"

formula="$work/tap/Formula/kitbash.rb"
[ -f "$formula" ] || { echo "error: $formula not found in $TAP_REPO" >&2; exit 1; }

# Same substitution the workflow performs.
if command -v gsed >/dev/null 2>&1; then SED=gsed; else SED=sed; fi
$SED -i.bak -E "s|url \".*\"|url \"${url}\"|; s|sha256 \".*\"|sha256 \"${sha}\"|" "$formula"
rm -f "${formula}.bak"

echo
git -C "$work/tap" --no-pager diff -- Formula/kitbash.rb
echo

if git -C "$work/tap" diff --quiet -- Formula/kitbash.rb; then
  echo "formula is already at ${VERSION} — nothing to do"
  exit 0
fi

if [ "$PUSH" != "--push" ]; then
  echo "dry run — re-run with --push to commit and push the change above"
  exit 0
fi

git -C "$work/tap" commit -qam "kitbash ${VERSION}"
GIT_ASKPASS= git -C "$work/tap" -c credential.helper='!gh auth git-credential' push -q origin HEAD
echo "pushed kitbash ${VERSION} to ${TAP_REPO}"
echo "verify with: brew update && brew info singhharsh1708/tap/kitbash"
