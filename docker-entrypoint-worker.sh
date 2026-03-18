#!/bin/sh
set -e

echo "Starting copy trade worker..."
exec node dist/worker.js
