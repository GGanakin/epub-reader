"""Parser and HTTP integration checks. Run: python3 -m unittest discover -s tests -v"""
import io
import json
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from server import EpubError, Library, create_server, parse_epub, resolve_href


def make_epub(version=3, broken=False, drm=False, no_toc=False):
    """Generate an original three-chapter Chinese fixture with nested links and an image."""
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("mimetype", "application/epub+zip", compress_type=zipfile.ZIP_STORED)
        archive.writestr("META-INF/container.xml", '''<?xml version="1.0"?>
<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="OPS/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>''')
        nav_item = '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>' if version == 3 else '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>'
        archive.writestr("OPS/package.opf", f'''<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="{version}.0" unique-identifier="id">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>在纸页之间</dc:title><dc:creator>纸间</dc:creator><dc:identifier id="id">paper-reader-demo-v{version}</dc:identifier><dc:language>zh-CN</dc:language></metadata>
<manifest>{'' if no_toc else nav_item}<item id="c1" href="Text/ch1.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="Text/%E7%AC%AC%E4%BA%8C%E7%AB%A0.xhtml" media-type="application/xhtml+xml"/><item id="c3" href="Text/ch3.xhtml" media-type="application/xhtml+xml"/><item id="css" href="Styles/book.css" media-type="text/css"/><item id="pic" href="Images/leaf.svg" media-type="image/svg+xml"/></manifest>
<spine toc="ncx"><itemref idref="c1"/><itemref idref="c2"/><itemref idref="c3"/></spine></package>''')
        archive.writestr("OPS/nav.xhtml", '''<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>目录</title></head><body><nav epub:type="toc"><ol><li><a href="Text/ch1.xhtml">第一章 把时间还给阅读</a><ol><li><a href="Text/ch1.xhtml#garden">一座随身的花园</a></li></ol></li><li><a href="Text/%E7%AC%AC%E4%BA%8C%E7%AB%A0.xhtml">第二章 在生活的间隙里</a></li><li><a href="Text/ch3.xhtml">第三章 留住这一页</a></li></ol></nav></body></html>''')
        archive.writestr("OPS/toc.ncx", '''<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><navMap><navPoint id="one"><navLabel><text>第一章 把时间还给阅读</text></navLabel><content src="Text/ch1.xhtml"/><navPoint id="garden"><navLabel><text>一座随身的花园</text></navLabel><content src="Text/ch1.xhtml#garden"/></navPoint></navPoint><navPoint id="two"><navLabel><text>第二章 在生活的间隙里</text></navLabel><content src="Text/%E7%AC%AC%E4%BA%8C%E7%AB%A0.xhtml"/></navPoint><navPoint id="three"><navLabel><text>第三章 留住这一页</text></navLabel><content src="Text/ch3.xhtml"/></navPoint></navMap></ncx>''')
        paragraphs = [
            "清晨的光落在窗边，杯中的热茶冒出轻轻的白气。你把手机放到一旁，翻开昨天还没有读完的书。世界并没有因此停止，只是它的声音，暂时小了一些。",
            "阅读不必总有一个宏大的目的。有时候，只是为了认识一个遥远的人，走进一座未曾到过的城市，或是在一句平常的话里，重新发现熟悉的生活。",
            "一本书的节奏，常常比我们的日子慢。它允许你停下来，回看前面的段落，或者望一会儿窗外。每一次停顿，都可以成为阅读的一部分。",
            "那些留在纸页之间的片刻，会在某个意想不到的午后重新浮现。你未必记得原来的句子，却记得读到它时，心里曾经亮起的一点光。",
            "给自己留一点不被安排的时间吧。不必读完一章，不必记住每一个名字。只要翻开，读上一页，就已经走进了另一种辽阔。",
        ]
        for index, (path, title) in enumerate([
            ("ch1.xhtml", "把时间还给阅读"), ("第二章.xhtml", "在生活的间隙里"), ("ch3.xhtml", "留住这一页"),
        ]):
            if broken and index == 1:
                continue
            body = f'<h1>第{"一二三"[index]}章　{title}</h1><p class="intro">慢一点，让文字和自己相遇。</p>'
            for i in range(30):
                if i == 12:
                    body += '<h2 id="garden">一座随身的花园</h2><img src="../Images/leaf.svg" alt="叶子插图" width="200" height="80"/>'
                body += f'<p id="p{i}">{paragraphs[(i + index) % len(paragraphs)]}</p>'
            body += '<p><a href="第二章.xhtml">前往第二章</a> · <a href="#garden">回到花园</a></p>'
            archive.writestr(f"OPS/Text/{path}", f'''<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml" lang="zh-CN"><head><title>{title}</title><link rel="stylesheet" href="../Styles/book.css"/><script>parent.__epub_script_executed = true;</script></head><body>{body}</body></html>''')
        archive.writestr("OPS/Styles/book.css", 'body {font-family:serif;color:#111;background:white} h1 {font-weight:400} .intro{opacity:.6} p {text-indent:2em} img {display:block;margin:2em auto}')
        archive.writestr("OPS/Images/leaf.svg", '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="80" viewBox="0 0 200 80"><path d="M50 65Q100-10 155 20Q150 80 50 65ZM50 65 143 28" fill="#d8e0cb" stroke="#687b58" stroke-width="2"/></svg>')
        if drm:
            archive.writestr("META-INF/encryption.xml", '<encryption><EncryptedData><CipherData><CipherReference URI="OPS/Text/ch1.xhtml"/></CipherData></EncryptedData></encryption>')
    return output.getvalue()


class ParserTests(unittest.TestCase):
    def test_epub3_nested_toc_unicode_and_reading_order(self):
        book = parse_epub(io.BytesIO(make_epub()))
        self.assertEqual(book["title"], "在纸页之间")
        self.assertEqual(len(book["chapters"]), 3)
        self.assertEqual(book["chapters"][1]["path"], "OPS/Text/第二章.xhtml")
        self.assertEqual(book["toc"][1]["depth"], 1)
        self.assertEqual(book["toc"][1]["href"], "OPS/Text/ch1.xhtml#garden")

    def test_epub2_ncx(self):
        book = parse_epub(io.BytesIO(make_epub(version=2)))
        self.assertEqual(len(book["toc"]), 4)
        self.assertEqual(book["toc"][1]["depth"], 1)
        self.assertEqual(book["chapters"][2]["title"], "第三章 留住这一页")

    def test_missing_toc_falls_back_to_spine(self):
        book = parse_epub(io.BytesIO(make_epub(no_toc=True)))
        self.assertEqual(len(book["toc"]), 3)

    def test_invalid_and_encrypted_books_report_errors(self):
        for data in [b"not a zip", make_epub(broken=True), make_epub(drm=True)]:
            with self.subTest(size=len(data)), self.assertRaises(EpubError):
                parse_epub(io.BytesIO(data))

    def test_path_resolution_rejects_escape_and_remote_content(self):
        for href in ["../../../../etc/passwd", "/etc/passwd", "https://example.com/ch.xhtml", "//example.com/x", "..\\evil"]:
            with self.subTest(href=href), self.assertRaises(EpubError):
                resolve_href("OPS/package.opf", href)
        self.assertEqual(resolve_href("OPS/Text/ch1.xhtml", "../Images/leaf.svg"), "OPS/Images/leaf.svg")

    def test_library_deduplicates_and_survives_restart(self):
        with tempfile.TemporaryDirectory() as temp:
            library = Library(temp)
            first = library.add(make_epub(), "第一本.epub")
            second = library.add(make_epub(), "renamed.epub")
            self.assertEqual(first["id"], second["id"])
            self.assertEqual(len(Library(temp).list()), 1)
            self.assertEqual(Library(temp).get(first["id"])["title"], "在纸页之间")

    def test_folder_import_discovers_new_books_and_preserves_originals(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            sources = root / "sources"
            sources.mkdir()
            first = sources / "第一本.EPUB"
            first.write_bytes(make_epub())
            (sources / "duplicate.epub").write_bytes(first.read_bytes())
            (sources / "ignored.azw3").write_bytes(b"not an epub")
            (sources / "broken.epub").write_bytes(b"not a zip")
            library = Library(root / "data", sources)
            self.assertEqual(len(library.list()), 1)
            self.assertTrue(first.exists())
            self.assertEqual(len(library.list()), 1)
            (sources / "broken.epub").write_bytes(make_epub(version=2))
            self.assertEqual(len(library.list()), 2)
            first.unlink()
            self.assertEqual(len(library.list()), 2)
            self.assertEqual(len(Library(root / "data", sources).list()), 2)

    def test_missing_source_directory_and_symlinks_do_not_import_other_files(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            sources = root / "sources"
            library = Library(root / "data", sources)
            self.assertEqual(library.list(), [])
            sources.mkdir()
            outside = root / "outside.epub"
            outside.write_bytes(make_epub())
            (sources / "link.epub").symlink_to(outside)
            self.assertEqual(library.list(), [])


class HttpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.server = create_server("127.0.0.1", 0, cls.temp.name)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = f"http://127.0.0.1:{cls.server.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown(); cls.server.server_close(); cls.thread.join(); cls.temp.cleanup()

    def test_import_read_asset_and_restart_metadata(self):
        request = urllib.request.Request(self.base + "/api/books", data=make_epub(), headers={"Content-Type": "application/epub+zip"})
        with urllib.request.urlopen(request) as response:
            self.assertEqual(response.status, 201)
            book = json.load(response)
        with urllib.request.urlopen(self.base + "/api/books") as response:
            self.assertEqual(json.load(response)[0]["id"], book["id"])
        with urllib.request.urlopen(self.base + f'/books/{book["id"]}/content/OPS/Text/ch1.xhtml') as response:
            self.assertIn("script-src 'none'", response.headers["Content-Security-Policy"])
            self.assertIn("sandbox allow-same-origin", response.headers["Content-Security-Policy"])
            self.assertIn("把时间还给阅读", response.read().decode())
        with urllib.request.urlopen(self.base + f'/books/{book["id"]}/content/OPS/Images/leaf.svg') as response:
            self.assertEqual(response.headers["Content-Type"], "image/svg+xml")

    def test_static_files_and_missing_resources(self):
        with urllib.request.urlopen(self.base + "/") as response:
            self.assertIn("纸间", response.read().decode())
        for path in ["/server.py", "/../server.py", "/data/test", "/api/books/invalid"]:
            with self.subTest(path=path), self.assertRaises(urllib.error.HTTPError) as raised:
                urllib.request.urlopen(self.base + path)
            self.assertEqual(raised.exception.code, 404)

    def test_cross_origin_and_wrong_upload_types_rejected(self):
        for headers, status in [({"Content-Type": "text/plain"}, 415), ({"Content-Type": "application/epub+zip", "Origin": "https://other.example"}, 403)]:
            request = urllib.request.Request(self.base + "/api/books", data=b"x", headers=headers)
            with self.assertRaises(urllib.error.HTTPError) as raised:
                urllib.request.urlopen(request)
            self.assertEqual(raised.exception.code, status)


if __name__ == "__main__":
    unittest.main()
