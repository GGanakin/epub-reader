#!/usr/bin/env python3
"""Create the original demo EPUB without adding it to the user's library."""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "tests"))
from test_reader import make_epub

if __name__ == "__main__":
    target = ROOT / "examples" / "在纸页之间.epub"
    target.parent.mkdir(exist_ok=True)
    target.write_bytes(make_epub())
    print(f"示例书已生成：{target}")
