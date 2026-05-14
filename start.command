#!/bin/bash
# ── Voting App Launcher ──────────────────────────────────
# Double-click this file on Mac to start the server.
# It opens a Terminal window automatically.

cd "$(dirname "$0")"

echo ""
echo "  Voting App — Starting..."
echo ""

# Install dependencies if needed
if [ ! -d "node_modules" ]; then
  echo "  Installing dependencies (first run only)..."
  npm install express socket.io osc
  echo ""
fi

# Start the server
node server.js
