#!/usr/bin/env bash
# oh-my-adhd capture popup
# Usage: bash capture.sh [threadId]
# Bind ⌥+ADH to this script in your hotkey manager (Raycast, Hammerspoon, etc.)

PORT=${OH_MY_ADHD_PORT:-3000}
THREAD_ARG=""
if [ -n "$1" ]; then
  THREAD_ARG="?threadId=$1"
fi

URL="http://localhost:${PORT}/capture${THREAD_ARG}"

# Open as a small popup window in the default browser
osascript <<EOF
tell application "Google Chrome"
  activate
  set w to make new window with properties {bounds:{200, 100, 760, 480}}
  set URL of active tab of w to "${URL}"
end tell
EOF

# Fallback: Safari
if [ $? -ne 0 ]; then
  osascript <<EOF2
tell application "Safari"
  activate
  make new document with properties {URL:"${URL}"}
end tell
EOF2
fi
