#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
exec python3 server.py --host "${EPUB_HOST:-0.0.0.0}" --port "${EPUB_PORT:-8765}" --books-dir "${EPUB_BOOKS_DIR:-/root/Bookshelf}" "$@"
