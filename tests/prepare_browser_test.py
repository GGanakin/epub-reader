"""Generate a fully offline browser test page and isolated Firefox preferences."""
import base64
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from test_reader import make_epub

ROOT = Path(__file__).resolve().parents[1]
TARGET = Path(sys.argv[1] if len(sys.argv) > 1 else "/tmp/paper-reader-check")
TARGET.mkdir(exist_ok=True)
profile = TARGET / "profile"
profile.mkdir(exist_ok=True)
preferences = {
    "browser.download.folderList": 2,
    "browser.download.dir": str(TARGET),
    "browser.download.useDownloadDir": True,
    "browser.download.always_ask_before_handling_new_types": False,
    "browser.helperApps.neverAsk.saveToDisk": "application/octet-stream,application/json",
    "browser.download.alwaysOpenPanel": False,
    "browser.shell.checkDefaultBrowser": False,
    "browser.aboutwelcome.enabled": False,
    "datareporting.policy.dataSubmissionEnabled": False,
    "toolkit.telemetry.enabled": False,
}
(profile / "user.js").write_text("\n".join(f"user_pref({json.dumps(k)}, {json.dumps(v)});" for k, v in preferences.items()))
fixtures = "\n".join(f"window.TEST_EPUB{v} = '{base64.b64encode(make_epub(version=v)).decode()}';" for v in (2, 3))
script = fixtures + "\n" + (ROOT / "tests" / "offline-smoke.js").read_text("utf-8")
page = (ROOT / "纸间阅读器.html").read_text("utf-8").replace("</body>", "<script>" + script + "</script></body>")
(TARGET / "smoke.html").write_text(page, "utf-8")
print(TARGET / "smoke.html")
