#!/bin/bash
echo "Post-merge setup: installing dependencies..."
npm install --production 2>&1
echo "Post-merge setup complete."
