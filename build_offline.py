#!/usr/bin/env python3
"""Build the Windows-friendly single HTML file. End users do not need Python."""
from pathlib import Path
import base64
import zipfile

ROOT = Path(__file__).resolve().parent
WEB = ROOT / "web"


def build():
    html = (WEB / "index.html").read_text("utf-8")
    favicon = base64.b64encode((WEB / "favicon.svg").read_bytes()).decode()
    html = html.replace('href="/favicon.svg"', f'href="data:image/svg+xml;base64,{favicon}"')
    policy = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\'; style-src \'unsafe-inline\' blob:; img-src data: blob:; font-src blob: data:; media-src blob:; frame-src \'self\' blob:; connect-src \'none\'; object-src \'none\'; base-uri \'none\'; form-action \'none\'">'
    html = html.replace('  <meta name="viewport"', f'  {policy}\n  <meta name="viewport"')
    css = (WEB / "style.css").read_text("utf-8").replace('</style', '<\\/style')
    html = html.replace('  <link rel="stylesheet" href="/style.css">', f"  <style>\n{css}\n</style>")
    html = html.replace('  <script src="/app.js" defer></script>', '')
    scripts = "\n".join((WEB / name).read_text("utf-8") for name in ("offline.js", "app.js"))
    scripts = scripts.replace('</script', '<\\/script')
    html = html.replace('</body>', '<script>\n' + scripts + '\n</script>\n</body>')
    target = ROOT / "纸间阅读器.html"
    target.write_text(html, "utf-8")
    with zipfile.ZipFile(ROOT / "纸间阅读器-Windows离线版.zip", "w", zipfile.ZIP_DEFLATED) as archive:
        archive.write(target, target.name)
        archive.write(ROOT / "Windows使用说明.txt", "Windows使用说明.txt")
        demo = ROOT / "examples" / "在纸页之间.epub"
        if demo.exists():
            archive.write(demo, "示例书-在纸页之间.epub")
    print(f"离线阅读器已生成：{target}")


if __name__ == "__main__":
    build()
