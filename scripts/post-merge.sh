#!/bin/bash
set -e

# Install dependencies. Skip the Electron binary download — the app runs
# headless on Replit (node src/index.js) and never launches Electron.
ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm install --no-audit --no-fund
