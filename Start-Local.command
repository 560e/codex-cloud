#!/bin/bash
cd -- "$(dirname -- "$0")" || exit 1
fail() {
  printf '%s\n' "$1"
  read -r -p 'Press Enter to close. ' _answer
  exit 1
}
# Finder may not inherit Homebrew's PATH. Preserve an already selected Node.
if ! command -v node >/dev/null 2>&1; then
  export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"
fi
command -v node >/dev/null 2>&1 || fail 'Install Node.js 24 LTS, then reopen this window.'
node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 24 ? 0 : 1)" || fail 'Node.js 24 or newer is required.'
command -v npm >/dev/null 2>&1 || fail 'npm is missing. Reinstall Node.js with npm.'
[[ -f node_modules/tsx/dist/cli.mjs ]] || fail 'Dependencies missing. Run: npm ci --include=dev. First setup: docs/LOCAL.md'
[[ -f dist/server/index.js && -f dist/client/index.html ]] || fail "Build missing. Run: npm run build"
printf '%s\n' 'Open http://127.0.0.1:18473 after the server is ready.' 'Keep this window open. Press Ctrl+C to stop.'
npm run start:local
launch_exit=$?
if [[ $launch_exit -ne 0 ]]; then
  read -r -p 'Startup stopped. Press Enter to close. ' _answer
fi
exit "$launch_exit"
