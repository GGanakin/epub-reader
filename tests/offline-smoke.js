/* Runs inside a generated copy of the offline page, with embedded fixtures. */
(async () => {
  const results = [];
  const check = (condition, label) => { if (!condition) throw new Error(label); results.push(label); };
  const wait = async predicate => {
    const stop = Date.now() + 12000;
    while (!predicate()) { if (Date.now() > stop) throw new Error("Timed out: " + predicate.toString()); await new Promise(r => setTimeout(r, 40)); }
  };
  const demoFile = (base64, name) => new File([Uint8Array.from(atob(base64), c => c.charCodeAt(0))], name, { type: "application/epub+zip" });
  const finish = report => {
    document.body.dataset.testResult = report.ok ? "passed" : "failed";
    const output = document.createElement("pre");
    output.textContent = JSON.stringify(report, null, 2);
    output.style.cssText = "position:fixed;inset:0;background:#fff;color:#111;z-index:10000;font:16px/1.7 monospace;overflow:auto;padding:25px;white-space:pre-wrap";
    document.body.append(output);
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: "application/octet-stream" }));
    link.download = "offline-test-result.json";
    link.click();
  };
  try {
    if (sessionStorage.getItem("paper-test-stage") === "reload") {
      const before = JSON.parse(sessionStorage.getItem("paper-test-before"));
      await wait(() => frameReady && !loading);
      check(book.id === before.id, "Restores the last book after a real page reload");
      check(currentHref === before.href, "Restores the last chapter after reload");
      check(Math.abs(getLocation().ratio - before.ratio) < .025, "Restores reading position after reload");
      check(record().bookmarks.length === 1 && record().bookmarks[0].note === "一段值得记住的文字", "Bookmark and note survive reload");
      check(state.settings.theme === "dark" && state.settings.fontSize === 24, "Appearance settings survive reload");
      check((await offline.list()).length === 2, "Both EPUB books persist in IndexedDB after reload");
      check(!window.__epub_script_executed, "Embedded book scripts remain disabled");
      check(!performance.getEntriesByType("resource").some(r => /^https?:/.test(r.name)), "No HTTP or HTTPS resources requested");
      finish({ ok: true, tests: [...before.results, ...results] });
      sessionStorage.removeItem("paper-test-stage");
      return;
    }
    await wait(() => !$("shelf-view").hidden);
    await importBooks([demoFile(window.TEST_EPUB3, "在纸页之间.epub")]);
    await wait(() => frameReady && !loading);
    check(book.chapters.length === 3 && book.toc.length === 4, "EPUB 3 metadata and nested table of contents");
    check(frameDoc().body.textContent.includes("把时间还给阅读"), "Chapter text renders inside the sandboxed frame");
    check(!frameDoc().querySelector("script") && !window.__epub_script_executed, "Book scripts are removed and never execute");
    check(frameDoc().querySelector("img").complete && frameDoc().querySelector("img").naturalWidth > 0, "Embedded SVG image loads without networking");
    check(offline.persistent, "IndexedDB is available for local file URLs");
    const mainId = book.id;
    const duplicate = await offline.add(demoFile(window.TEST_EPUB3, "改名.epub"));
    check(duplicate.id === mainId && (await offline.list()).length === 1, "Duplicate EPUB content is not imported twice");
    await navigate(book.toc[1].href);
    await wait(() => frameReady && !loading);
    check(Math.abs(frameDoc().getElementById("garden").getBoundingClientRect().top) < 3, "Nested chapter anchor navigation");
    await navigate(book.chapters[0].href);
    await wait(() => frameReady && !loading);
    $("chapter-progress").value = 610;
    $("chapter-progress").dispatchEvent(new Event("input", { bubbles: true }));
    check(Math.abs(getLocation().ratio - .61) < .01, "Progress slider jumps within a chapter");
    $("bookmark-button").click();
    $("bookmark-note").value = "一段值得记住的文字";
    $("bookmark-form").dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    check(record().bookmarks.length === 1, "Bookmark stores the current reading location and note");
    document.querySelector('.theme-option[data-theme="dark"]').click();
    check(frameDoc().defaultView.getComputedStyle(frameDoc().body).backgroundColor === "rgb(32, 38, 32)", "Night theme applies to the book body");
    $("font-size").value = 24; $("font-size").dispatchEvent(new Event("input", { bubbles: true }));
    check(frameDoc().defaultView.getComputedStyle(frameDoc().body).fontSize === "24px", "Font-size control applies to book text");
    $("next-button").click(); await wait(() => frameReady && !loading);
    check(currentHref.includes("第二章") && frameDoc().body.textContent.includes("在生活的间隙里"), "Next chapter handles Unicode archive paths");
    $("marks-tab").click(); $("marks-list").querySelector(".bookmark-jump").click();
    await wait(() => frameReady && !loading);
    check(chapterIndex === 0 && getLocation().anchor === record().bookmarks[0].anchor, "Bookmark jump restores the paragraph after a font-size change");
    frameDoc().querySelector('a[data-epub-href*="第二章"]').click();
    await wait(() => frameReady && !loading);
    check(chapterIndex === 1, "Internal links navigate between chapters");
    const second = await offline.add(demoFile(window.TEST_EPUB2, "EPUB2示例.epub"));
    check(second.chapters.length === 3 && second.toc[1].depth === 1, "EPUB 2 NCX nested navigation");
    await Promise.all([openBook(second.id), openBook(mainId)]);
    await wait(() => frameReady && !loading);
    check(book.id === mainId && offline.active.id === mainId, "Rapid book switching keeps the selected book and archive consistent");
    let invalid = false;
    try { await offline.add(new File(["not an epub"], "损坏.epub")); } catch { invalid = true; }
    check(invalid, "Invalid EPUB files produce a readable error");
    const backup = { version: 1, ...JSON.parse(JSON.stringify(state)) };
    const marksBefore = record().bookmarks.length;
    mergeRecords(backup); mergeRecords(backup);
    check(record().bookmarks.length === marksBefore, "Backup import merges bookmarks without duplicates");
    saveProgress();
    sessionStorage.setItem("paper-test-before", JSON.stringify({ id: book.id, href: currentHref, ratio: getLocation().ratio, results }));
    sessionStorage.setItem("paper-test-stage", "reload");
    location.reload();
  } catch (error) {
    finish({ ok: false, tests: results, error: error.message, stack: error.stack, toast: $("toast").textContent });
  }
})();
