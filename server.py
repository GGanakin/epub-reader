#!/usr/bin/env python3
"""纸间 EPUB reader. Python 3.10+, standard library only."""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import mimetypes
import os
import posixpath
import re
import sys
import tempfile
import threading
import time
import webbrowser
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import quote, unquote, urlsplit
from xml.etree import ElementTree as ET

ROOT = Path(__file__).resolve().parent
MAX_UPLOAD = 100 * 1024 * 1024
MAX_EXPANDED = 400 * 1024 * 1024
MAX_MEMBER = 32 * 1024 * 1024
BOOK_ID = re.compile(r"^[a-f0-9]{64}$")


class EpubError(ValueError):
    pass


def local_name(tag):
    return tag.rsplit("}", 1)[-1]


def elements(root, name):
    return (item for item in root.iter() if local_name(item.tag) == name)


def resolve_href(base, href):
    """Resolve archive references; preserve fragments but never allow external URLs."""
    parts = urlsplit(href)
    if parts.scheme or parts.netloc:
        raise EpubError("EPUB 引用了外部章节，暂不支持。")
    path = posixpath.normpath(posixpath.join(posixpath.dirname(base), unquote(parts.path))) if parts.path else base
    if path.startswith(("../", "/")) or path == ".." or "\\" in path or "\x00" in path:
        raise EpubError("EPUB 内部路径无效。")
    return path + ("#" + parts.fragment if parts.fragment else "")


def read_xml(archive, path):
    try:
        data = archive.read(path)
        if b"<!ENTITY" in data.upper():
            raise EpubError("EPUB 包含不支持的 XML 实体声明。")
        return ET.fromstring(data)
    except (KeyError, ET.ParseError) as exc:
        raise EpubError(f"无法读取 EPUB 结构：{path}") from exc


def parse_epub(source, filename="book.epub"):
    try:
        with zipfile.ZipFile(source) as archive:
            entries = archive.infolist()
            if len(entries) > 15000 or sum(i.file_size for i in entries) > MAX_EXPANDED:
                raise EpubError("书籍解压后过大（上限 400 MB / 15000 个文件）。")
            if any(i.file_size > MAX_MEMBER or i.flag_bits & 1 for i in entries):
                raise EpubError("书籍含加密文件，或单个资源超过 32 MB。")
            names = {i.filename for i in entries}
            if len(names) != len(entries):
                raise EpubError("EPUB 内部包含重复文件名。")
            container = read_xml(archive, "META-INF/container.xml")
            rootfiles = list(elements(container, "rootfile"))
            if not rootfiles:
                raise EpubError("找不到 EPUB 内容清单。")
            package_path = resolve_href("", rootfiles[0].get("full-path", ""))
            package = read_xml(archive, package_path)
            manifest = {}
            for item in elements(package, "item"):
                manifest[item.get("id")] = {
                    "href": resolve_href(package_path, item.get("href", "")),
                    "type": item.get("media-type", ""),
                    "properties": item.get("properties", "").split(),
                }
            spine = next(elements(package, "spine"), None)
            if spine is None:
                raise EpubError("EPUB 缺少阅读顺序。")
            chapters = []
            for ref in elements(spine, "itemref"):
                item = manifest.get(ref.get("idref"))
                if item and item["type"] in ("application/xhtml+xml", "text/html"):
                    path = item["href"].split("#", 1)[0]
                    if path not in names:
                        raise EpubError(f"章节文件不存在：{path}")
                    chapters.append({"href": item["href"], "path": path, "title": f"第 {len(chapters) + 1} 节"})
            if not chapters:
                raise EpubError("未找到可阅读的章节。")
            if "META-INF/encryption.xml" in names:
                encryption = read_xml(archive, "META-INF/encryption.xml")
                chapter_paths = {c["path"] for c in chapters}
                for ref in elements(encryption, "CipherReference"):
                    if resolve_href("", ref.get("URI", "")).split("#", 1)[0] in chapter_paths:
                        raise EpubError("这本书的正文受 DRM 加密保护，无法读取。")

            toc = []
            nav = next((m for m in manifest.values() if "nav" in m["properties"]), None)
            if nav:
                nav_path = nav["href"].split("#", 1)[0]
                doc = read_xml(archive, nav_path)
                nav_nodes = list(elements(doc, "nav"))
                toc_nav = next((n for n in nav_nodes if "toc" in n.get("{http://www.idpf.org/2007/ops}type", "").split() or n.get("role") == "doc-toc"), None)
                if toc_nav is not None:
                    def walk(node, depth=-1):
                        if local_name(node.tag) in ("ol", "ul"):
                            depth += 1
                        if local_name(node.tag) == "a" and node.get("href"):
                            try:
                                href = resolve_href(nav_path, node.get("href"))
                                if href.split("#", 1)[0] in names:
                                    toc.append({"label": "".join(node.itertext()).strip() or "未命名章节", "href": href, "depth": max(0, depth)})
                            except EpubError:
                                pass
                        for child in node:
                            walk(child, depth)
                    walk(toc_nav)
            if not toc:
                ncx = manifest.get(spine.get("toc")) or next((m for m in manifest.values() if m["type"] == "application/x-dtbncx+xml"), None)
                if ncx:
                    ncx_path = ncx["href"].split("#", 1)[0]
                    doc = read_xml(archive, ncx_path)
                    def walk_ncx(node, depth=0):
                        for child in node:
                            if local_name(child.tag) == "navPoint":
                                label = next(elements(child, "navLabel"), None)
                                content = next(elements(child, "content"), None)
                                if content is not None:
                                    href = resolve_href(ncx_path, content.get("src", ""))
                                    if href.split("#", 1)[0] in names:
                                        toc.append({"label": "".join(label.itertext()).strip() if label is not None else "未命名章节", "href": href, "depth": depth})
                                walk_ncx(child, depth + 1)
                            else:
                                walk_ncx(child, depth)
                    walk_ncx(doc)
            labels = {}
            for entry in toc:
                labels.setdefault(entry["href"].split("#", 1)[0], entry["label"])
            for chapter in chapters:
                chapter["title"] = labels.get(chapter["path"], chapter["title"])
            if not toc:
                toc = [{"label": c["title"], "href": c["href"], "depth": 0} for c in chapters]
            title = next(elements(package, "title"), None)
            author = next(elements(package, "creator"), None)
            return {
                "title": "".join(title.itertext()).strip() if title is not None else Path(filename).stem,
                "author": "".join(author.itertext()).strip() if author is not None else "未知作者",
                "filename": filename, "chapters": chapters, "toc": toc,
            }
    except (zipfile.BadZipFile, RuntimeError, NotImplementedError) as exc:
        raise EpubError("无法打开此 EPUB，请确认文件完整且没有加密。") from exc


class Library:
    def __init__(self, folder, books_dir=None):
        self.folder = Path(folder)
        self.folder.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        self.books_dir = Path(books_dir).resolve() if books_dir else None
        self.source_stamps = {}
        self.source_error = None

    def sync_folder(self):
        """Import new/changed EPUBs from the configured local directory only.

        Caller holds the library lock. Originals are never moved or deleted;
        imported copies remain readable if a source file is later removed.
        """
        if self.books_dir is None:
            return
        try:
            paths = sorted(self.books_dir.iterdir())
            self.source_error = None
        except OSError as exc:
            if str(exc) != self.source_error:
                print(f"无法扫描书籍目录：{exc}", file=sys.stderr, flush=True)
                self.source_error = str(exc)
            return
        seen = set()
        for path in paths:
            if path.suffix.lower() != ".epub" or path.is_symlink():
                continue
            seen.add(path)
            try:
                if not path.is_file():
                    continue
                info = path.stat()
                stamp = (info.st_mtime_ns, info.st_size)
                if self.source_stamps.get(path) == stamp:
                    continue
                self.source_stamps[path] = stamp
                if not 0 < info.st_size <= MAX_UPLOAD:
                    raise EpubError("文件大小必须在 1 字节至 100 MB 之间。")
                with path.open("rb") as source:
                    data = source.read(MAX_UPLOAD + 1)
                if len(data) > MAX_UPLOAD:
                    raise EpubError("文件超过 100 MB。")
                self.add(data, path.name)
            except (OSError, ValueError, zipfile.BadZipFile) as exc:
                print(f"未导入 {path.name}：{exc}", file=sys.stderr, flush=True)
        self.source_stamps = {path: stamp for path, stamp in self.source_stamps.items() if path in seen}

    def get(self, book_id):
        if not BOOK_ID.fullmatch(book_id):
            raise FileNotFoundError
        return json.loads((self.folder / f"{book_id}.json").read_text("utf-8"))

    def list(self):
        with self.lock:
            self.sync_folder()
            books = []
            for path in self.folder.glob("*.json"):
                if not BOOK_ID.fullmatch(path.stem):
                    continue
                try:
                    book = self.get(path.stem)
                    books.append({k: book[k] for k in ("id", "title", "author", "filename", "added")})
                except (OSError, ValueError, KeyError):
                    continue
            return sorted(books, key=lambda b: b["added"], reverse=True)

    def add(self, data, filename):
        book_id = hashlib.sha256(data).hexdigest()
        with self.lock:
            try:
                return self.get(book_id)
            except FileNotFoundError:
                pass
            metadata = parse_epub(io.BytesIO(data), filename)
            metadata.update(id=book_id, added=time.time())
            self.atomic_write(self.folder / f"{book_id}.epub", data)
            self.atomic_write(self.folder / f"{book_id}.json", json.dumps(metadata, ensure_ascii=False).encode("utf-8"))
            return metadata

    @staticmethod
    def atomic_write(path, data):
        fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".upload-")
        try:
            with os.fdopen(fd, "wb") as file:
                file.write(data)
            os.replace(tmp, path)
        finally:
            if os.path.exists(tmp):
                os.unlink(tmp)


class Handler(BaseHTTPRequestHandler):
    server_version = "PaperReader/1.0"

    def respond(self, data, content_type="application/json; charset=utf-8", status=200, book=False):
        if not isinstance(data, bytes):
            data = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Cache-Control", "no-cache")
        csp = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'"
        if book:
            csp = "default-src 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; media-src 'self'; script-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; sandbox allow-same-origin"
        self.send_header("Content-Security-Policy", csp)
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        path = unquote(urlsplit(self.path).path)
        try:
            if path == "/api/books":
                return self.respond(self.server.library.list())
            match = re.fullmatch(r"/api/books/([a-f0-9]{64})", path)
            if match:
                return self.respond(self.server.library.get(match[1]))
            match = re.fullmatch(r"/books/([a-f0-9]{64})/content/(.+)", path)
            if match:
                self.server.library.get(match[1])
                name = match[2]
                if posixpath.normpath(name) != name or name.startswith("/") or "\\" in name or name.startswith("../"):
                    raise FileNotFoundError
                with zipfile.ZipFile(self.server.library.folder / f"{match[1]}.epub") as archive:
                    content = archive.read(name)
                mime = mimetypes.guess_type(name)[0] or "application/octet-stream"
                if name.lower().endswith((".xhtml", ".html", ".htm")):
                    mime = "application/xhtml+xml" if name.lower().endswith(".xhtml") else "text/html"
                return self.respond(content, mime, book=True)
            static_files = {"/": "index.html", "/index.html": "index.html", "/app.js": "app.js", "/style.css": "style.css", "/favicon.svg": "favicon.svg"}
            if path in static_files:
                file = ROOT / "web" / static_files[path]
                mime = mimetypes.guess_type(file.name)[0] or "text/plain"
                return self.respond(file.read_bytes(), mime + "; charset=utf-8")
            raise FileNotFoundError
        except (FileNotFoundError, KeyError):
            self.respond({"error": "文件不存在。"}, status=404)
        except (OSError, ValueError, zipfile.BadZipFile):
            self.respond({"error": "无法读取书籍文件。"}, status=500)

    def do_POST(self):
        if self.path != "/api/books":
            return self.respond({"error": "接口不存在。"}, status=404)
        # A raw EPUB upload also prevents cross-site HTML forms from writing files.
        if self.headers.get("Content-Type", "").split(";")[0] != "application/epub+zip":
            return self.respond({"error": "请选择 EPUB 文件。"}, status=415)
        origin = self.headers.get("Origin")
        if origin and urlsplit(origin).netloc != self.headers.get("Host"):
            return self.respond({"error": "不允许跨站上传。"}, status=403)
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if not 0 < size <= MAX_UPLOAD:
                return self.respond({"error": "请选择不超过 100 MB 的 EPUB 文件。"}, status=413)
            self.connection.settimeout(60)
            data = self.rfile.read(size)
            if len(data) != size:
                raise EpubError("上传未完成，请重试。")
            filename = unquote(self.headers.get("X-Filename", "book.epub"))[:255]
            book = self.server.library.add(data, filename)
            self.respond(book, status=201)
        except (EpubError, ValueError) as exc:
            self.respond({"error": str(exc)}, status=400)
        except (OSError, TimeoutError):
            self.respond({"error": "保存失败，请检查磁盘空间或重新上传。"}, status=500)


def create_server(host="127.0.0.1", port=8765, data_dir=None, books_dir=None):
    server = ThreadingHTTPServer((host, port), Handler)
    server.library = Library(data_dir or ROOT / "data", books_dir)
    server.daemon_threads = True
    return server


def main():
    parser = argparse.ArgumentParser(description="纸间 · 本地 EPUB 阅读器（无需第三方依赖）")
    parser.add_argument("--host", default="127.0.0.1", help="监听地址，默认仅本机")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--data-dir", type=Path, default=ROOT / "data", help="书籍保存目录")
    parser.add_argument("--books-dir", type=Path, help="自动导入此目录中的 EPUB；刷新书架时发现新增文件")
    parser.add_argument("--open", action="store_true", help="启动时打开浏览器")
    args = parser.parse_args()
    try:
        server = create_server(args.host, args.port, args.data_dir, args.books_dir)
    except OSError as exc:
        parser.exit(1, f"无法启动：{exc}\n可用 --port 8766 更换端口。\n")
    url = f"http://{'127.0.0.1' if args.host == '0.0.0.0' else args.host}:{server.server_port}"
    print(f"纸间 EPUB 阅读器：{url}\n书籍目录：{args.data_dir.resolve()}\n按 Ctrl+C 停止。", flush=True)
    if args.books_dir:
        print(f"自动导入目录：{args.books_dir.resolve()}", flush=True)
    if args.open:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止。")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
