"use strict";

const $ = (id) => document.getElementById(id);
const STORAGE_KEY = "paper-reader-v1";
const defaults = { theme: "paper", background: "#f6f3ec", color: "#33392f", fontSize: 20, lineHeight: 1.9, width: 760, font: "serif" };
const themes = { paper: ["#f6f3ec", "#33392f"], light: ["#ffffff", "#30372f"], green: ["#e7eddf", "#2e4031"], dark: ["#202620", "#d2d9c8"] };
const state = { settings: { ...defaults }, books: {}, lastBook: null };
let library = [], book = null, chapterIndex = 0, currentHref = "", pendingLocation = null, loading = false;
let saveTimer, toastTimer, pendingBookmark, uploading = false, frameReady = false, openRequest = 0, navigationRequest = 0;
const offline = window.offlineLibrary || null;
const mobileLayout = matchMedia("(max-width:760px)");
if (offline) {
  $("storage-label").textContent = "本地书籍 · 安心阅读";
  $("import-description").textContent = "选择 EPUB 文件，或将它拖入页面。书籍留在本机，随时接着上次读。";
}
if (matchMedia("(pointer:coarse)").matches) {
  document.querySelector(".settings-note").textContent = "配色、字号与阅读位置会自动记住。上下滑动阅读，底部切换章节，专注模式可收起工具栏。";
}

function toast(message) {
  $("toast").textContent = message;
  $("toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $("toast").hidden = true; }, 4200);
}

function validLocation(value) {
  return value && typeof value.href === "string" && value.href.length < 4096 && !value.href.startsWith("/") && !value.href.split("/").includes("..") && !/^[a-z][a-z\d+.-]*:/i.test(value.href);
}

function cleanLocation(value) {
  return {
    href: value.href, ratio: Math.max(0, Math.min(1, Number(value.ratio) || 0)),
    anchor: Number.isInteger(value.anchor) && value.anchor >= 0 ? value.anchor : null,
    offset: Math.max(-1, Math.min(1, Number(value.offset) || 0)),
    chapter: Math.max(0, Number(value.chapter) || 0), total: Math.max(1, Number(value.total) || 1),
    title: String(value.title || "书签").slice(0, 300), updated: Number(value.updated) || Date.now(),
  };
}

function cleanSettings(value) {
  const result = { ...defaults };
  if (!value || typeof value !== "object") return result;
  if (value.theme in themes || value.theme === "custom") result.theme = value.theme;
  for (const key of ["background", "color"]) if (/^#[0-9a-f]{6}$/i.test(value[key])) result[key] = value[key];
  for (const [key, min, max] of [["fontSize", 14, 36], ["lineHeight", 1.3, 2.6], ["width", 480, 1100]]) {
    if (Number.isFinite(Number(value[key]))) result[key] = Math.min(max, Math.max(min, Number(value[key])));
  }
  if (["serif", "sans", "original"].includes(value.font)) result.font = value.font;
  return result;
}

function mergeRecords(data, replaceSettings = true) {
  if (!data || data.version !== 1 || !data.books || typeof data.books !== "object") throw new Error("不是有效的纸间阅读记录文件。");
  if (replaceSettings) state.settings = cleanSettings(data.settings);
  for (const [id, entry] of Object.entries(data.books)) {
    if (!/^[a-f0-9]{64}$/.test(id) || !entry || typeof entry !== "object") continue;
    const target = state.books[id] ||= { bookmarks: [] };
    if (validLocation(entry.progress) && (!target.progress || Number(entry.progress.updated) > target.progress.updated)) target.progress = cleanLocation(entry.progress);
    for (const mark of Array.isArray(entry.bookmarks) ? entry.bookmarks : []) {
      if (!validLocation(mark) || typeof mark.id !== "string" || target.bookmarks.some(m => m.id === mark.id)) continue;
      target.bookmarks.push({ ...cleanLocation(mark), id: mark.id.slice(0, 100), note: String(mark.note || "").slice(0, 200), created: Number(mark.created) || Date.now() });
    }
  }
  if (typeof data.lastBook === "string" && /^[a-f0-9]{64}$/.test(data.lastBook)) state.lastBook = data.lastBook;
}

try {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored) mergeRecords(JSON.parse(stored));
} catch { setTimeout(() => toast("无法读取本地记录。你仍可阅读，并使用导出功能保存记录。"), 500); }

function persist() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, ...state })); return true; }
  catch { toast("浏览器无法保存记录，请使用左下角按钮导出备份。"); return false; }
}

function record() { return state.books[book.id] ||= { bookmarks: [] }; }

async function api(url, options) {
  if (offline) {
    if (options?.method === "POST") return offline.add(options.body);
    if (url === "/api/books") return offline.list();
    return offline.get(url.split("/").pop());
  }
  let response;
  try { response = await fetch(url, options); }
  catch { throw new Error("暂时无法连接阅读服务，请检查网络后重试。"); }
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "请求失败，请重试。");
  return data;
}

function make(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function overall(progress) {
  return Math.min(100, Math.round(((progress.chapter || 0) + (progress.ratio || 0)) / (progress.total || 1) * 100));
}

function renderLibrary() {
  $("book-count").textContent = library.length;
  $("shelf-count").textContent = String(library.length).padStart(2, "0");
  $("empty-library").hidden = library.length > 0;
  $("library-section").hidden = library.length === 0;
  $("book-grid").replaceChildren();
  const colors = ["#718164", "#9b755c", "#637d82", "#8a7b92", "#a59160", "#687b89"];
  for (const [index, item] of library.entries()) {
    const button = make("button", "book-card");
    const cover = make("div", "book-cover");
    cover.style.setProperty("--cover", colors[index % colors.length]);
    cover.append(make("strong", "", item.title), make("span", "", item.author), make("small", "", "PAPER · READING"));
    const progress = state.books[item.id]?.progress;
    button.append(cover, make("h3", "", item.title), make("p", "", progress ? `已读约 ${overall(progress)}% · 继续阅读` : `${item.author} · 尚未开始`));
    const bar = make("div", "book-card-progress"), fill = make("span");
    fill.style.width = `${progress ? overall(progress) : 0}%`; bar.append(fill); button.append(bar);
    button.title = `阅读《${item.title}》`; button.addEventListener("click", () => openBook(item.id));
    $("book-grid").append(button);
  }
}

function showShelf() {
  openRequest++;
  saveProgress();
  $("shelf-view").hidden = false; $("reader-view").hidden = true;
  $("book-navigation").hidden = true; $("sidebar-welcome").hidden = false;
  $("view-title").textContent = "我的书架"; $("view-subtitle").textContent = "让阅读，慢下来。";
  $("bookmark-button").disabled = true; $("focus-button").disabled = true;
  document.body.classList.remove("is-reading");
  toggleFocus(false); closeSidebar(); toggleSettings(false);
  state.lastBook = null; persist(); renderLibrary();
  document.title = "纸间 · EPUB 阅读器";
  refreshLibrary();
}

async function refreshLibrary(notify = false) {
  const control = $("refresh-library");
  if (control.disabled) return;
  control.disabled = true; control.textContent = "正在刷新…";
  try {
    library = await api("/api/books"); renderLibrary();
    if (notify) toast(`书架已更新，共 ${library.length} 本书。`);
  } catch (error) { toast(error.message); }
  finally { control.disabled = false; control.textContent = "刷新书架"; }
}

async function openBook(id) {
  const request = ++openRequest;
  saveProgress();
  try {
    const nextBook = await api(`/api/books/${id}`);
    if (request !== openRequest) return;
    if (offline) offline.activate(nextBook);
    book = nextBook; frameReady = false;
    $("shelf-view").hidden = true; $("reader-view").hidden = false;
    document.body.classList.add("is-reading");
    $("book-navigation").hidden = false; $("sidebar-welcome").hidden = true;
    $("sidebar-title").textContent = book.title; $("sidebar-author").textContent = book.author;
    $("sidebar-title").title = book.title; $("sidebar-author").title = book.author;
    $("view-title").textContent = book.title; $("view-subtitle").textContent = book.author;
    $("focus-button").disabled = false;
    state.lastBook = id; persist();
    $("toc-search").value = "";
    renderToc(); renderBookmarks(); switchTab("toc");
    document.title = `${book.title} · 纸间`;
    const progress = record().progress;
    navigate(progress?.href || book.chapters[0].href, progress || { ratio: 0 }, false);
  } catch (error) { toast(error.message); }
}

function renderToc() {
  if (!book) return;
  const query = $("toc-search").value.trim().toLocaleLowerCase();
  $("toc-list").replaceChildren();
  for (const item of book.toc) {
    if (query && !item.label.toLocaleLowerCase().includes(query)) continue;
    const button = make("button", "toc-item", item.label);
    button.style.paddingLeft = `${10 + Math.min(item.depth, 6) * 13}px`;
    button.dataset.href = item.href;
    button.addEventListener("click", () => navigate(item.href));
    $("toc-list").append(button);
  }
  if (!$("toc-list").children.length) $("toc-list").append(make("p", "empty-marks", "没有匹配的章节。"));
  updateActiveToc();
}

function updateActiveToc() {
  for (const node of $("toc-list").children) {
    if (!node.dataset.href) continue;
    const active = node.dataset.href === currentHref || (!currentHref.includes("#") && node.dataset.href.split("#")[0] === currentHref);
    node.classList.toggle("active", active);
    if (active) node.setAttribute("aria-current", "location"); else node.removeAttribute("aria-current");
  }
}

function switchTab(tab) {
  for (const name of ["toc", "marks"]) {
    $(`${name}-tab`).setAttribute("aria-selected", String(name === tab));
    $(`${name}-panel`).hidden = name !== tab;
  }
}

function bookUrl(href) {
  const hash = href.indexOf("#"), path = hash < 0 ? href : href.slice(0, hash);
  return `/books/${book.id}/content/${path.split("/").map(encodeURIComponent).join("/")}${hash < 0 ? "" : href.slice(hash)}`;
}

async function navigate(href, location = null, save = true) {
  if (!book || !validLocation({ href })) return;
  const request = ++navigationRequest;
  if (save) saveProgress();
  const index = book.chapters.findIndex(c => c.path === href.split("#")[0]);
  if (index >= 0) chapterIndex = index;
  else chapterIndex = Math.min(location?.chapter || chapterIndex, book.chapters.length - 1);
  currentHref = href;
  pendingLocation = location;
  loading = true; frameReady = false;
  $("bookmark-button").disabled = true;
  $("chapter-loading").hidden = false;
  $("previous-button").disabled = chapterIndex === 0;
  $("next-button").disabled = chapterIndex === book.chapters.length - 1;
  const tocEntry = book.toc.find(t => t.href === href);
  $("chapter-label").textContent = `${String(chapterIndex + 1).padStart(2, "0")} / ${book.chapters.length}　${tocEntry?.label || book.chapters[chapterIndex].title}`;
  updateActiveToc();
  closeSidebar();
  // Removing the old frame avoids a same-document fragment navigation missing its load event.
  try {
    const html = offline ? await offline.chapter(href) : null;
    if (request !== navigationRequest) return;
    const old = $("reader-frame"), frame = old.cloneNode(false);
    frame.addEventListener("load", onFrameLoad);
    if (offline) frame.srcdoc = html; else frame.src = bookUrl(href);
    old.replaceWith(frame);
  } catch (error) {
    if (request !== navigationRequest) return;
    loading = false; $("chapter-loading").hidden = true;
    toast(`章节无法显示：${error.message}`);
  }
}

function frameDoc() { try { return $("reader-frame").contentDocument; } catch { return null; } }
function scrolling() { const doc = frameDoc(); return doc?.scrollingElement || doc?.documentElement; }
function blocks() { return Array.from(frameDoc()?.querySelectorAll("p,h1,h2,h3,h4,h5,h6,li,blockquote,pre,figure,table") || []); }

function getLocation() {
  const el = scrolling();
  if (!book || !el || !frameReady || loading) return null;
  const max = Math.max(0, el.scrollHeight - el.clientHeight);
  const nodes = blocks();
  const anchor = nodes.findIndex(node => { const r = node.getBoundingClientRect(); return r.bottom > 0 && r.height > 0; });
  const rect = anchor >= 0 ? nodes[anchor].getBoundingClientRect() : null;
  return {
    href: currentHref, ratio: max ? Math.min(1, Math.max(0, el.scrollTop / max)) : 0,
    anchor: anchor >= 0 ? anchor : null, offset: rect ? Math.max(-1, Math.min(1, -rect.top / rect.height)) : 0,
    chapter: chapterIndex, total: book.chapters.length,
    title: book.toc.find(t => t.href === currentHref)?.label || book.chapters[chapterIndex].title,
    updated: Date.now(),
  };
}

function restoreLocation(location) {
  const el = scrolling(); if (!el) return;
  if (location) {
    const node = Number.isInteger(location.anchor) ? blocks()[location.anchor] : null;
    if (node) {
      const rect = node.getBoundingClientRect();
      el.scrollTop += rect.top + (location.offset || 0) * rect.height;
    } else el.scrollTop = (location.ratio || 0) * Math.max(0, el.scrollHeight - el.clientHeight);
  } else if (currentHref.includes("#")) {
    let fragment = currentHref.slice(currentHref.indexOf("#") + 1);
    try { fragment = decodeURIComponent(fragment); } catch { /* Keep malformed fragments literal. */ }
    const doc = frameDoc(), target = doc.getElementById(fragment) || Array.from(doc.getElementsByName(fragment))[0];
    if (target) target.scrollIntoView(); else el.scrollTop = 0;
  } else el.scrollTop = 0;
}

async function onFrameLoad(event) {
  const frame = event.currentTarget;
  if (frame !== $("reader-frame")) return;
  const doc = frameDoc();
  if (!doc?.body || doc.querySelector("parsererror") || doc.contentType === "application/json") {
    loading = false; $("chapter-loading").hidden = true;
    toast("此章节无法显示，可能已损坏。可从目录选择其他章节。"); return;
  }
  applyBookStyle();
  if (doc.fonts?.ready) await Promise.race([doc.fonts.ready, new Promise(resolve => setTimeout(resolve, 1200))]);
  if (frame !== $("reader-frame")) return;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (frame !== $("reader-frame")) return;
    restoreLocation(pendingLocation); pendingLocation = null;
    loading = false; frameReady = true;
    $("chapter-loading").hidden = true; $("bookmark-button").disabled = false;
    doc.addEventListener("scroll", () => { if (!loading) { updateProgress(); clearTimeout(saveTimer); saveTimer = setTimeout(saveProgress, 350); } }, { passive: true });
    doc.addEventListener("click", handleBookLink, true);
    doc.addEventListener("click", () => toggleSettings(false));
    doc.addEventListener("keydown", handleKey);
    saveProgress();
  }));
}

function handleBookLink(event) {
  const link = event.target.closest?.("a"); if (!link) return;
  if (offline) {
    event.preventDefault();
    if (link.dataset.epubHref) navigate(link.dataset.epubHref);
    return;
  }
  const href = link.getAttribute("href") || link.getAttribute("xlink:href"); if (!href) return;
  event.preventDefault();
  const url = new URL(href, $("reader-frame").src);
  const prefix = `/books/${book.id}/content/`;
  if (url.origin === location.origin && url.pathname.startsWith(prefix)) {
    let path;
    try { path = decodeURIComponent(url.pathname.slice(prefix.length)); } catch { return; }
    if (/\.(x?html?|xml)$/i.test(path)) navigate(path + url.hash);
    else toast("这个链接不是可阅读的章节。");
  } else if (["https:", "http:"].includes(url.protocol)) {
    window.open(url.href, "_blank", "noopener,noreferrer");
  }
}

function updateProgress() {
  const value = getLocation(); if (!value) return;
  $("chapter-progress").value = Math.round(value.ratio * 1000);
  $("progress-label").textContent = `本章 ${Math.round(value.ratio * 100)}%`;
  $("overall-progress").textContent = `全书约 ${overall(value)}%`;
}

function saveProgress() {
  clearTimeout(saveTimer);
  if ($("reader-view").hidden) return;
  const progress = getLocation(); if (!progress) return;
  record().progress = progress;
  if (persist()) $("saved-status").textContent = "阅读位置已保存";
  updateProgress();
}

function applyBookStyle() {
  const doc = frameDoc(); if (!doc?.documentElement) return;
  let style = doc.getElementById("paper-reader-style");
  if (!style) { style = doc.createElementNS("http://www.w3.org/1999/xhtml", "style"); style.id = "paper-reader-style"; (doc.head || doc.documentElement).append(style); }
  const s = state.settings;
  const font = s.font === "serif" ? '"Songti SC", "Noto Serif CJK SC", "Source Han Serif SC", "SimSun", Georgia, serif' : '-apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif';
  style.textContent = `
    :root { color-scheme: ${s.theme === "dark" ? "dark" : "light"}; }
    html { background: ${s.background} !important; color: ${s.color} !important; scroll-behavior: auto !important; overflow-x: hidden !important; -webkit-text-size-adjust: 100%; text-size-adjust: 100%; }
    body { box-sizing: border-box !important; background: ${s.background} !important; color: ${s.color} !important; font-size: ${s.fontSize}px !important; line-height: ${s.lineHeight} !important; width: auto !important; max-width: ${s.width}px !important; min-width: 0 !important; margin: 0 auto !important; padding: 30px 38px 90px !important; writing-mode: horizontal-tb !important; column-count: auto !important; }
    body * { color: inherit !important; background-color: transparent !important; line-height: ${s.lineHeight} !important; ${s.font !== "original" ? `font-family: ${font} !important;` : ""} }
    p, li, div, span, blockquote, td { font-size: inherit !important; }
    h1 { font-size: 1.75em !important; } h2 { font-size: 1.45em !important; } h3 { font-size: 1.2em !important; }
    p { margin-top: .85em !important; margin-bottom: .85em !important; overflow-wrap: anywhere; }
    a { color: ${s.theme === "dark" ? "#b7cba4" : "#627356"} !important; text-underline-offset: 3px; }
    img, svg, video { max-width: 100% !important; height: auto; object-fit: contain; }
    pre { white-space: pre-wrap !important; overflow-wrap: anywhere; } table { display: block; overflow-x: auto; max-width: 100% !important; }
    ::selection { background: #a9be8680; }
    @media(max-width:600px) { body { padding: 16px 22px 85px !important; } h1 { font-size: 1.45em !important; } }
  `;
}

function applySettings(keepLocation = true) {
  const position = keepLocation ? getLocation() : null;
  const s = state.settings;
  document.documentElement.dataset.theme = s.theme === "custom" ? (parseInt(s.background.slice(1, 3), 16) < 100 ? "dark" : "paper") : s.theme;
  document.documentElement.style.setProperty("--bg", s.background);
  document.documentElement.style.setProperty("--text", s.color);
  document.querySelector('meta[name="theme-color"]').content = s.background;
  for (const button of document.querySelectorAll(".theme-option")) {
    button.classList.toggle("active", button.dataset.theme === s.theme);
    button.setAttribute("aria-pressed", String(button.dataset.theme === s.theme));
  }
  $("background-color").value = s.background; $("text-color").value = s.color;
  $("font-size").value = s.fontSize; $("font-size-value").textContent = `${s.fontSize} px`;
  $("line-height").value = s.lineHeight; $("line-height-value").textContent = s.lineHeight.toFixed(1);
  $("reading-width").value = s.width; $("reading-width-value").textContent = `${s.width} px`;
  $("font-family").value = s.font;
  applyBookStyle();
  if (position) { restoreLocation(position); saveProgress(); }
  persist();
}

function renderBookmarks() {
  if (!book) return;
  const marks = record().bookmarks;
  $("mark-count").textContent = marks.length; $("marks-list").replaceChildren();
  if (!marks.length) $("marks-list").append(make("p", "empty-marks", "还没有书签。读到喜欢的地方，点击上方书签图标，或按 B，留住这一页。"));
  for (const mark of [...marks].sort((a, b) => b.created - a.created)) {
    const card = make("div", "bookmark-card"), jump = make("button", "bookmark-jump");
    jump.append(make("strong", "", mark.title));
    if (mark.note) jump.append(make("p", "", mark.note));
    jump.append(make("small", "", `本章 ${Math.round(mark.ratio * 100)}% · ${new Date(mark.created).toLocaleDateString("zh-CN")}`));
    jump.addEventListener("click", () => navigate(mark.href, mark));
    const remove = make("button", "delete-mark", "×"); remove.title = "删除书签"; remove.setAttribute("aria-label", `删除书签：${mark.note || mark.title}`);
    remove.addEventListener("click", () => { record().bookmarks = marks.filter(m => m.id !== mark.id); persist(); renderBookmarks(); toast("已删除书签。"); });
    card.append(jump, remove); $("marks-list").append(card);
  }
}

function addBookmark() {
  if ($("reader-view").hidden) return;
  pendingBookmark = getLocation(); if (!pendingBookmark) return;
  $("bookmark-location").textContent = `${pendingBookmark.title} · 本章 ${Math.round(pendingBookmark.ratio * 100)}%`;
  $("bookmark-note").value = ""; $("bookmark-dialog").showModal(); $("bookmark-note").focus();
}

function syncPanels() {
  const navigation = mobileLayout.matches && document.body.classList.contains("sidebar-open");
  const settings = mobileLayout.matches && !$("appearance-panel").hidden;
  $("main-content").inert = navigation || settings;
  $("sidebar").inert = settings || (mobileLayout.matches && !navigation);
  $("exit-focus").inert = navigation || settings;
  $("settings-scrim").hidden = !settings;
  $("sidebar-scrim").hidden = !navigation;
  $("menu-button").setAttribute("aria-expanded", String(mobileLayout.matches ? navigation : !document.body.classList.contains("sidebar-collapsed") && !document.body.classList.contains("focus-mode")));
  for (const [id, modal] of [["sidebar", navigation], ["appearance-panel", settings]]) {
    if (modal) { $(id).setAttribute("role", "dialog"); $(id).setAttribute("aria-modal", "true"); }
    else { $(id).removeAttribute("role"); $(id).removeAttribute("aria-modal"); }
  }
}

function closeSidebar() {
  const restoreFocus = $("sidebar").contains(document.activeElement) && mobileLayout.matches;
  document.body.classList.remove("sidebar-open"); syncPanels();
  if (restoreFocus) $("menu-button").focus();
}

function toggleSettings(show = $("appearance-panel").hidden) {
  const changed = show === $("appearance-panel").hidden;
  if (show) closeSidebar();
  $("appearance-panel").hidden = !show;
  $("appearance-button").setAttribute("aria-expanded", String(show));
  syncPanels();
  if (changed && show) $("close-settings").focus();
  else if (changed && $("appearance-panel").contains(document.activeElement)) $("appearance-button").focus();
}

function toggleFocus(show = !document.body.classList.contains("focus-mode")) {
  if ($("reader-view").hidden) show = false;
  const position = getLocation();
  toggleSettings(false); closeSidebar();
  document.body.classList.toggle("focus-mode", show);
  $("exit-focus").hidden = !show;
  $("focus-button").setAttribute("aria-pressed", String(show));
  syncPanels();
  if (position) requestAnimationFrame(() => { restoreLocation(position); saveProgress(); });
  if (mobileLayout.matches && !$("reader-view").hidden) $(show ? "exit-focus" : "focus-button").focus();
}

function handleKey(event) {
  if (event.key === "Escape") { toggleSettings(false); closeSidebar(); toggleFocus(false); return; }
  const modal = mobileLayout.matches && (!$("appearance-panel").hidden ? $("appearance-panel") : document.body.classList.contains("sidebar-open") ? $("sidebar") : null);
  if (modal) {
    if (event.key === "Tab") {
      const items = [...modal.querySelectorAll('button:not(:disabled),a[href],input,select')].filter(el => el.getClientRects().length);
      const first = items[0], last = items.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
    return;
  }
  if (event.ctrlKey || event.metaKey || event.altKey || event.target.closest?.("input,select,textarea,[contenteditable=true]") || $("bookmark-dialog").open || $("reader-view").hidden) return;
  if (event.key === "ArrowLeft" && chapterIndex > 0) { event.preventDefault(); navigate(book.chapters[chapterIndex - 1].href); }
  if (event.key === "ArrowRight" && chapterIndex < book.chapters.length - 1) { event.preventDefault(); navigate(book.chapters[chapterIndex + 1].href); }
  if (event.key.toLowerCase() === "b") { event.preventDefault(); addBookmark(); }
  if (event.key.toLowerCase() === "f") { event.preventDefault(); toggleFocus(); }
}

async function importBooks(files) {
  if (uploading) { toast("正在导入，请稍候。"); return; }
  const epubs = [...files].filter(f => /\.epub$/i.test(f.name));
  if (!epubs.length) { toast("请选择 .epub 格式的电子书。"); return; }
  uploading = true; $("import-button").disabled = true; $("first-import").disabled = true;
  let last = null, success = 0;
  try {
    for (const file of epubs) {
      if (file.size > 100 * 1024 * 1024) { toast(`《${file.name}》超过 100 MB，已跳过。`); continue; }
      toast(`正在导入《${file.name}》…`);
      try {
        last = await api("/api/books", { method: "POST", headers: { "Content-Type": "application/epub+zip", "X-Filename": encodeURIComponent(file.name) }, body: file });
        success++;
      } catch (error) { toast(error.message); }
    }
    library = await api("/api/books"); renderLibrary();
    if (last) {
      await openBook(last.id);
      toast(offline && !offline.persistent ? "浏览器未能长期保存书籍，本次仍可阅读。请保留原 EPUB，并导出阅读记录。" : `已导入 ${success} 本书${success < epubs.length ? `，${epubs.length - success} 本未导入` : "，开始阅读吧。"}`);
    }
  } catch (error) { toast(error.message); }
  finally { uploading = false; $("import-button").disabled = false; $("first-import").disabled = false; $("file-input").value = ""; }
}

$("import-button").addEventListener("click", () => $("file-input").click());
$("first-import").addEventListener("click", () => $("file-input").click());
$("refresh-library").addEventListener("click", () => refreshLibrary(true));
$("file-input").addEventListener("change", event => importBooks(event.target.files));
$("brand").addEventListener("click", event => { event.preventDefault(); showShelf(); });
$("shelf-button").addEventListener("click", showShelf);
$("toc-search").addEventListener("input", renderToc);
$("toc-tab").addEventListener("click", () => switchTab("toc"));
$("marks-tab").addEventListener("click", () => switchTab("marks"));
$("previous-button").addEventListener("click", () => { if (chapterIndex > 0) navigate(book.chapters[chapterIndex - 1].href); });
$("next-button").addEventListener("click", () => { if (chapterIndex < book.chapters.length - 1) navigate(book.chapters[chapterIndex + 1].href); });
$("chapter-progress").addEventListener("input", event => {
  const el = scrolling(); if (!el || !frameReady) return;
  el.scrollTop = Number(event.target.value) / 1000 * Math.max(0, el.scrollHeight - el.clientHeight); saveProgress();
});
$("appearance-button").addEventListener("click", () => toggleSettings());
$("close-settings").addEventListener("click", () => toggleSettings(false));
document.addEventListener("click", event => { if (!event.target.closest("#appearance-panel,#appearance-button")) toggleSettings(false); });
for (const button of document.querySelectorAll(".theme-option")) button.addEventListener("click", () => {
  const name = button.dataset.theme; state.settings.theme = name;
  [state.settings.background, state.settings.color] = themes[name]; applySettings();
});
for (const [id, key] of [["background-color", "background"], ["text-color", "color"]]) $(id).addEventListener("input", event => {
  state.settings[key] = event.target.value; state.settings.theme = "custom"; applySettings();
});
for (const [id, key] of [["font-size", "fontSize"], ["line-height", "lineHeight"], ["reading-width", "width"]]) $(id).addEventListener("input", event => { state.settings[key] = Number(event.target.value); applySettings(); });
$("font-family").addEventListener("change", event => { state.settings.font = event.target.value; applySettings(); });
$("reset-settings").addEventListener("click", () => { state.settings = { ...defaults }; applySettings(); });
$("menu-button").addEventListener("click", () => {
  toggleSettings(false);
  if (mobileLayout.matches) {
    document.body.classList.toggle("sidebar-open"); syncPanels();
    if (document.body.classList.contains("sidebar-open")) $("close-sidebar").focus();
  } else { toggleFocus(false); document.body.classList.toggle("sidebar-collapsed"); syncPanels(); }
});
$("sidebar-scrim").addEventListener("click", closeSidebar);
$("close-sidebar").addEventListener("click", closeSidebar);
$("settings-scrim").addEventListener("click", () => toggleSettings(false));
$("focus-button").addEventListener("click", () => toggleFocus());
$("exit-focus").addEventListener("click", () => toggleFocus(false));
mobileLayout.addEventListener("change", () => { closeSidebar(); syncPanels(); });
$("bookmark-button").addEventListener("click", addBookmark);
for (const id of ["cancel-bookmark", "cancel-bookmark-bottom"]) $(id).addEventListener("click", () => $("bookmark-dialog").close());
$("bookmark-form").addEventListener("submit", event => {
  event.preventDefault(); if (!pendingBookmark) return;
  const id = typeof crypto.randomUUID === "function" ? crypto.randomUUID() : Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, "0")).join("");
  record().bookmarks.push({ ...pendingBookmark, id, note: $("bookmark-note").value.trim(), created: Date.now() });
  persist(); renderBookmarks(); $("bookmark-dialog").close(); toast("已留下书签，下次从这里继续。");
});
$("backup-button").addEventListener("click", () => {
  saveProgress();
  const blob = new Blob([JSON.stringify({ version: 1, ...state }, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob), link = make("a"); link.href = url;
  link.download = `纸间阅读记录-${new Date().toISOString().slice(0, 10)}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 10000);
  toast(offline ? "阅读记录已导出。迁移时也请保留原来的 EPUB 文件。" : "阅读记录已导出；书籍文件保存在项目的 data 目录。");
});
$("restore-button").addEventListener("click", () => $("backup-input").click());
$("backup-input").addEventListener("change", async event => {
  const file = event.target.files[0]; if (!file) return;
  try {
    if (file.size > 10 * 1024 * 1024) throw new Error("阅读记录文件过大（上限 10 MB）。");
    saveProgress(); mergeRecords(JSON.parse(await file.text())); persist(); applySettings(); renderLibrary(); renderBookmarks(); toast("已合并书签与最新阅读进度。");
  } catch (error) { toast(`导入失败：${error.message}`); }
  event.target.value = "";
});
let dragDepth = 0;
document.addEventListener("dragenter", event => { if ([...event.dataTransfer.types].includes("Files")) { event.preventDefault(); dragDepth++; $("drop-overlay").hidden = false; } });
document.addEventListener("dragover", event => { if ([...event.dataTransfer.types].includes("Files")) event.preventDefault(); });
document.addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; $("drop-overlay").hidden = true; } });
document.addEventListener("drop", event => { event.preventDefault(); dragDepth = 0; $("drop-overlay").hidden = true; importBooks(event.dataTransfer.files); });
document.addEventListener("keydown", handleKey);
window.addEventListener("pagehide", saveProgress);
document.addEventListener("visibilitychange", () => { if (document.hidden) saveProgress(); });
applySettings(false);
syncPanels();
api("/api/books").then(items => {
  library = items; renderLibrary();
  if (state.lastBook && library.some(item => item.id === state.lastBook)) openBook(state.lastBook);
}).catch(error => toast(error.message));
