#!/usr/bin/env bash
#
# Optional git post-merge hook: reinstall runtime dependencies after a pull.
#
# To use, symlink or copy this file into your local hooks directory:
#   ln -s ../../scripts/post-merge.sh .git/hooks/post-merge
#
set -e

echo "Post-merge setup: installing dependencies..."
npm install --omit=dev
echo "Post-merge setup complete."
