#!/usr/bin/env bash
set -euo pipefail
[[ "$RELEASE_TAG" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]
if [[ "$GITHUB_EVENT_NAME" == workflow_dispatch ]]; then
  [[ "$GITHUB_REF" == refs/heads/main ]]
else
  [[ "$GITHUB_REF" == "refs/tags/$RELEASE_TAG" ]]
fi
git fetch --no-tags origin main
sha=$(git rev-parse --verify "refs/tags/$RELEASE_TAG^{commit}")
git merge-base --is-ancestor "$sha" origin/main
version=$(git show "$sha:package.json" | node -e 'let text="";process.stdin.on("data",chunk=>text+=chunk);process.stdin.on("end",()=>console.log(JSON.parse(text).version));')
[[ "$RELEASE_TAG" == "v$version" ]]
{ printf 'sha=%s\n' "$sha"; printf 'tag=%s\n' "$RELEASE_TAG"; } >> "$GITHUB_OUTPUT"
