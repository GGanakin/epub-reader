"use strict";

// The offline edition uses only browser APIs. No fetch, CDN, server, or package install.
(() => {
  const LIMIT = 32 * 1024 * 1024;
  const names = (root, name) => Array.from(root.getElementsByTagNameNS("*", name));
  const textOf = node => node?.textContent.trim() || "";
  const fail = message => { throw new Error(message); };
  function splitHref(href) {
    const index = href.indexOf("#");
    return index < 0 ? [href, ""] : [href.slice(0, index), href.slice(index)];
  }
  function resolve(base, href) {
    if (/^[a-z][a-z\d+.-]*:/i.test(href) || href.startsWith("//")) fail("书籍引用了外部资源。");
    const [raw, hash] = splitHref(href);
    if (!raw) return splitHref(base)[0] + hash;
    let decoded;
    try { decoded = decodeURIComponent(raw.split("?")[0]); } catch { decoded = raw; }
    if (decoded.startsWith("/") || decoded.includes("\\") || decoded.includes("\0")) fail("EPUB 内部路径无效。");
    const output = splitHref(base)[0].split("/").slice(0, -1);
    for (const part of decoded.split("/")) {
      if (part === "..") { if (!output.length) fail("EPUB 内部路径无效。"); output.pop(); }
      else if (part && part !== ".") output.push(part);
    }
    return output.join("/") + hash;
  }

  const crcTable = Array.from({ length: 256 }, (_, n) => {
    for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
    return n >>> 0;
  });
  function crc32(bytes) {
    let value = 0xffffffff;
    for (const byte of bytes) value = crcTable[(value ^ byte) & 255] ^ (value >>> 8);
    return (value ^ 0xffffffff) >>> 0;
  }

  class Zip {
    constructor(buffer) {
      this.buffer = buffer;
      this.entries = new Map();
      const view = new DataView(buffer);
      if (view.byteLength < 22) fail("文件不是有效的 EPUB 压缩包。");
      let end = -1;
      for (let i = view.byteLength - 22; i >= Math.max(0, view.byteLength - 65557); i--) {
        if (view.getUint32(i, true) === 0x06054b50 && i + 22 + view.getUint16(i + 20, true) === view.byteLength) { end = i; break; }
      }
      if (end < 0) fail("EPUB 不完整，找不到文件目录。");
      const count = view.getUint16(end + 10, true);
      let pos = view.getUint32(end + 16, true), total = 0;
      if (view.getUint16(end + 4, true) || view.getUint16(end + 6, true) || count > 15000 || count === 65535) fail("暂不支持分卷、ZIP64 或过大的 EPUB。");
      for (let i = 0; i < count; i++) {
        if (pos + 46 > end || view.getUint32(pos, true) !== 0x02014b50) fail("EPUB 文件目录已损坏。");
        const flags = view.getUint16(pos + 8, true), method = view.getUint16(pos + 10, true);
        const crc = view.getUint32(pos + 16, true), compressed = view.getUint32(pos + 20, true), size = view.getUint32(pos + 24, true);
        const length = view.getUint16(pos + 28, true), extra = view.getUint16(pos + 30, true), comment = view.getUint16(pos + 32, true);
        const offset = view.getUint32(pos + 42, true);
        if (pos + 46 + length + extra + comment > end) fail("EPUB 目录长度无效。");
        let name = new TextDecoder("utf-8").decode(new Uint8Array(buffer, pos + 46, length));
        // Honor the Info-ZIP Unicode Path extra field used by some older EPUB tools.
        for (let at = pos + 46 + length, stop = at + extra; at + 4 <= stop;) {
          const tag = view.getUint16(at, true), len = view.getUint16(at + 2, true);
          if (at + 4 + len > stop) break;
          if (tag === 0x7075 && len >= 5 && view.getUint8(at + 4) === 1 && view.getUint32(at + 5, true) === crc32(new Uint8Array(buffer, pos + 46, length))) name = new TextDecoder().decode(new Uint8Array(buffer, at + 9, len - 5));
          at += 4 + len;
        }
        total += size;
        if (flags & 1) fail("这本书包含加密文件，无法直接读取。");
        if (size > LIMIT || total > 400 * 1024 * 1024) fail("书籍解压后过大（单资源 32 MB，全书 400 MB）。");
        if (this.entries.has(name)) fail("EPUB 含重复文件名。");
        this.entries.set(name, { offset, size, compressed, method, crc });
        pos += 46 + length + extra + comment;
      }
    }

    async read(path) {
      const entry = this.entries.get(path);
      if (!entry) fail(`书籍缺少文件：${path}`);
      const view = new DataView(this.buffer), at = entry.offset;
      if (at + 30 > view.byteLength || view.getUint32(at, true) !== 0x04034b50) fail("EPUB 文件头已损坏。");
      const start = at + 30 + view.getUint16(at + 26, true) + view.getUint16(at + 28, true);
      if (start + entry.compressed > view.byteLength) fail("EPUB 资源不完整。");
      const compressed = new Uint8Array(this.buffer, start, entry.compressed);
      let result;
      if (entry.method === 0) result = compressed;
      else if (entry.method === 8) {
        let inflater;
        try { inflater = new DecompressionStream("deflate-raw"); }
        catch { fail("当前浏览器不支持 EPUB 解压，请使用较新版本的 Windows Edge 或 Chrome。"); }
        const reader = new Blob([compressed]).stream().pipeThrough(inflater).getReader();
        const chunks = []; let length = 0;
        try {
          while (true) {
            const { value, done } = await reader.read(); if (done) break;
            length += value.length;
            if (length > LIMIT || length > entry.size) { await reader.cancel(); fail("EPUB 解压大小不符，文件可能已损坏。"); }
            chunks.push(value);
          }
        } finally { reader.releaseLock(); }
        result = new Uint8Array(length); let offset = 0;
        for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
      } else fail("此 EPUB 使用了不支持的压缩方式。");
      if (result.length !== entry.size || crc32(result) !== entry.crc) fail(`书籍文件校验失败：${path}`);
      return result;
    }

    async text(path) {
      const bytes = await this.read(path);
      if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes);
      if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes);
      const prolog = new TextDecoder().decode(bytes.slice(0, 250));
      const encoding = prolog.match(/<\?xml[^>]*encoding=["']([^"']+)["']/i)?.[1] || "utf-8";
      try { return new TextDecoder(encoding).decode(bytes); } catch { return new TextDecoder().decode(bytes); }
    }

    async xml(path) {
      const text = await this.text(path);
      if (/<!ENTITY/i.test(text)) fail("不支持带 XML 实体声明的 EPUB。");
      const doc = new DOMParser().parseFromString(text, "application/xml");
      if (doc.querySelector("parsererror")) fail(`无法解析书籍结构：${path}`);
      return doc;
    }
  }

  async function metadata(zip, filename) {
    const container = await zip.xml("META-INF/container.xml");
    const rootfile = names(container, "rootfile")[0];
    if (!rootfile) fail("书籍缺少内容清单。");
    const packagePath = resolve("", rootfile.getAttribute("full-path") || "");
    const packageDoc = await zip.xml(packagePath);
    const manifest = new Map();
    for (const item of names(packageDoc, "item")) {
      const raw = item.getAttribute("href") || "";
      if (/^[a-z][a-z\d+.-]*:|^\/\//i.test(raw)) continue;
      manifest.set(item.getAttribute("id"), { href: resolve(packagePath, raw), type: item.getAttribute("media-type"), properties: (item.getAttribute("properties") || "").split(/\s+/) });
    }
    const spine = names(packageDoc, "spine")[0];
    if (!spine) fail("书籍缺少阅读顺序。");
    const chapters = [];
    for (const ref of names(spine, "itemref")) {
      const item = manifest.get(ref.getAttribute("idref"));
      if (!item || !["application/xhtml+xml", "text/html"].includes(item.type)) continue;
      const path = splitHref(item.href)[0];
      if (!zip.entries.has(path)) fail(`章节文件不存在：${path}`);
      chapters.push({ href: item.href, path, title: `第 ${chapters.length + 1} 节` });
    }
    if (!chapters.length) fail("未找到可阅读的章节。");
    if (zip.entries.has("META-INF/encryption.xml")) {
      const enc = await zip.xml("META-INF/encryption.xml");
      for (const node of names(enc, "CipherReference")) {
        if (chapters.some(c => c.path === resolve("", node.getAttribute("URI") || ""))) fail("这本书的正文受 DRM 加密保护，无法读取。");
      }
    }
    let toc = [];
    const nav = [...manifest.values()].find(item => item.properties.includes("nav"));
    if (nav) {
      const navDoc = await zip.xml(splitHref(nav.href)[0]);
      const tocNav = names(navDoc, "nav").find(n => (n.getAttributeNS("http://www.idpf.org/2007/ops", "type") || "").split(/\s+/).includes("toc") || n.getAttribute("role") === "doc-toc");
      function walk(node, depth = -1) {
        if (["ol", "ul"].includes(node.localName)) depth++;
        if (node.localName === "a" && node.getAttribute("href")) {
          try {
            const href = resolve(nav.href, node.getAttribute("href"));
            if (zip.entries.has(splitHref(href)[0])) toc.push({ label: textOf(node) || "未命名章节", href, depth: Math.max(0, depth) });
          } catch { /* Remote navigation entries are unavailable offline. */ }
        }
        for (const child of node.children) walk(child, depth);
      }
      if (tocNav) walk(tocNav);
    }
    if (!toc.length) {
      const ncx = manifest.get(spine.getAttribute("toc")) || [...manifest.values()].find(item => item.type === "application/x-dtbncx+xml");
      if (ncx) {
        const doc = await zip.xml(splitHref(ncx.href)[0]);
        function walk(node, depth = 0) {
          for (const child of node.children) {
            if (child.localName === "navPoint") {
              const content = names(child, "content")[0], label = names(child, "navLabel")[0];
              if (content) {
                const href = resolve(ncx.href, content.getAttribute("src") || "");
                if (zip.entries.has(splitHref(href)[0])) toc.push({ label: textOf(label) || "未命名章节", href, depth });
              }
              walk(child, depth + 1);
            } else walk(child, depth);
          }
        }
        walk(doc);
      }
    }
    for (const chapter of chapters) chapter.title = toc.find(item => splitHref(item.href)[0] === chapter.path)?.label || chapter.title;
    if (!toc.length) toc = chapters.map(c => ({ label: c.title, href: c.href, depth: 0 }));
    return { title: textOf(names(packageDoc, "title")[0]) || filename.replace(/\.epub$/i, ""), author: textOf(names(packageDoc, "creator")[0]) || "未知作者", filename, chapters, toc };
  }

  const mime = path => ({ css: "text/css", svg: "image/svg+xml", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", avif: "image/avif", woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", otf: "font/otf", mp3: "audio/mpeg", mp4: "video/mp4" }[path.split(".").pop().toLowerCase()] || "application/octet-stream");
  class OfflineLibrary {
    constructor() { this.memory = new Map(); this.active = null; this.urls = new Map(); this.generation = 0; this.persistent = true; }

    async db() {
      if (!this.dbPromise) this.dbPromise = new Promise(resolve => {
        try {
          const request = indexedDB.open("paper-reader-offline-v1", 1);
          request.onupgradeneeded = () => {
            request.result.createObjectStore("books", { keyPath: "id" });
            request.result.createObjectStore("files");
          };
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => { this.persistent = false; resolve(null); };
          request.onblocked = () => { this.persistent = false; resolve(null); };
        } catch { this.persistent = false; resolve(null); }
      });
      return this.dbPromise;
    }

    async query(store, method, ...args) {
      const db = await this.db(); if (!db) return null;
      return new Promise((resolve, reject) => {
        const tx = db.transaction(store, "readonly"), request = tx.objectStore(store)[method](...args);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(new Error("浏览器无法读取书架记录。"));
      });
    }

    async list() {
      const saved = await this.query("books", "getAll") || [];
      const items = new Map(saved.map(item => [item.id, item]));
      for (const [id, entry] of this.memory) items.set(id, entry.book);
      return [...items.values()].sort((a, b) => b.added - a.added);
    }

    async add(file) {
      if (file.size > 100 * 1024 * 1024) fail("单本书籍不能超过 100 MB。");
      if (!crypto.subtle) fail("当前浏览器不能直接读取本地书籍，请用新版 Edge 或 Chrome 打开这个 HTML 文件。");
      const buffer = await file.arrayBuffer();
      const digest = await crypto.subtle.digest("SHA-256", buffer);
      const id = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
      const existing = this.memory.get(id)?.book || await this.query("books", "get", id);
      if (existing) return existing;
      const zip = new Zip(buffer), book = { ...await metadata(zip, file.name), id, added: Date.now() };
      this.memory.set(id, { book, buffer });
      const db = await this.db();
      if (db) {
        try {
          await new Promise((resolve, reject) => {
            const tx = db.transaction(["books", "files"], "readwrite");
            tx.objectStore("books").put(book); tx.objectStore("files").put(buffer, id);
            tx.oncomplete = resolve;
            tx.onerror = tx.onabort = () => reject(new Error("书架保存失败"));
          });
          this.memory.delete(id);
        } catch { this.persistent = false; }
      }
      return book;
    }

    async get(id) {
      const entry = this.memory.get(id);
      const book = entry?.book || await this.query("books", "get", id);
      const buffer = entry?.buffer || await this.query("files", "get", id);
      if (!book || !buffer) fail("未找到书籍，请重新导入原来的 EPUB 文件。");
      return { ...book, archive: new Zip(buffer) };
    }

    activate(book) {
      this.dispose();
      this.active = { id: book.id, zip: book.archive };
      delete book.archive;
    }

    dispose() {
      this.generation++;
      for (const url of this.urls.values()) URL.revokeObjectURL(url);
      this.urls.clear();
      this.active = null;
    }

    async asset(path, trail = []) {
      path = splitHref(path)[0];
      if (this.urls.has(path)) return this.urls.get(path);
      if (!this.active || trail.includes(path) || trail.length > 8 || !this.active.zip.entries.has(path)) return "";
      const generation = this.generation, zip = this.active.zip;
      let data;
      if (mime(path) === "text/css") data = await this.css(await zip.text(path), path, [...trail, path]);
      else if (mime(path) === "image/svg+xml") {
        const doc = new DOMParser().parseFromString(await zip.text(path), "image/svg+xml");
        for (const node of doc.querySelectorAll("script,foreignObject,iframe,object,embed,style")) node.remove();
        for (const node of doc.querySelectorAll("*")) for (const attr of [...node.attributes]) {
          if (/^on/i.test(attr.name) || ((attr.localName === "href" || attr.localName === "src") && !attr.value.startsWith("#"))) node.removeAttributeNode(attr);
        }
        data = new XMLSerializer().serializeToString(doc);
      } else data = await zip.read(path);
      if (generation !== this.generation) return "";
      const url = URL.createObjectURL(new Blob([data], { type: mime(path) }));
      if (this.urls.has(path)) URL.revokeObjectURL(url); else this.urls.set(path, url);
      return this.urls.get(path);
    }

    async css(source, base, trail = []) {
      // Turn embedded resource references into local blobs; CSP blocks all networking.
      source = source.replace(/\/\*[\s\S]*?\*\//g, "");
      const imports = [...source.matchAll(/@import\s+(?:url\(\s*)?["']([^"']+)["']\s*\)?[^;]*;/gi)];
      for (const match of imports) {
        let replacement = "";
        try {
          const target = resolve(base, match[1]);
          if (!trail.includes(target) && trail.length < 8 && this.active.zip.entries.has(target)) replacement = await this.css(await this.active.zip.text(target), target, [...trail, target]);
        } catch { /* Ignore missing and external styles. */ }
        source = source.replace(match[0], replacement);
      }
      const references = [...source.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^\s)]*))\s*\)/gi)];
      for (const match of references) {
        const target = match[1] ?? match[2] ?? match[3];
        if (target.startsWith("#") || target.startsWith("data:") || target.startsWith("blob:")) continue;
        let url = "";
        try { url = await this.asset(resolve(base, target), trail); } catch { /* Fall back to normal text layout. */ }
        source = source.replace(match[0], `url("${url}")`);
      }
      return source;
    }

    async chapter(href) {
      if (!this.active) fail("请先打开书籍。");
      const generation = this.generation, path = splitHref(href)[0];
      const source = await this.active.zip.text(path);
      // Parsing as HTML tolerates common imperfect EPUB XHTML. Nothing is attached live.
      const doc = new DOMParser().parseFromString(source, "text/html");
      for (const node of doc.querySelectorAll("script,iframe,frame,frameset,object,embed,base,meta,form,foreignObject")) node.remove();
      for (const node of doc.querySelectorAll("*")) {
        for (const attr of [...node.attributes]) if (/^on/i.test(attr.name) || ["srcdoc", "srcset", "ping", "action", "formaction"].includes(attr.name)) node.removeAttributeNode(attr);
        if (node.hasAttribute("style")) node.setAttribute("style", await this.css(node.getAttribute("style"), path));
        if (node.localName === "a") {
          const raw = node.getAttribute("href") || node.getAttribute("xlink:href") || "";
          node.removeAttribute("href"); node.removeAttribute("xlink:href"); node.removeAttribute("target");
          if (raw) {
            try { node.dataset.epubHref = resolve(path, raw); node.setAttribute("href", "#"); }
            catch { node.setAttribute("title", "离线阅读不打开外部链接"); }
          }
        } else {
          for (const attribute of ["src", "poster", "href", "xlink:href"]) {
            const raw = node.getAttribute(attribute); if (!raw) continue;
            if (raw.startsWith("#") || (/^data:image\//i.test(raw) && ["img", "image"].includes(node.localName))) continue;
            node.removeAttribute(attribute);
            try {
              const url = await this.asset(resolve(path, raw));
              if (url) node.setAttribute(attribute, url);
            } catch { /* Missing optional resources must not prevent text from opening. */ }
          }
        }
      }
      for (const style of doc.querySelectorAll("style")) style.textContent = await this.css(style.textContent, path);
      if (generation !== this.generation) fail("书籍已切换。");
      const policy = doc.createElement("meta"); policy.httpEquiv = "Content-Security-Policy";
      policy.content = "default-src 'none'; script-src 'none'; connect-src 'none'; img-src blob: data:; style-src 'unsafe-inline' blob:; font-src blob: data:; media-src blob:; object-src 'none'; base-uri 'none'; form-action 'none'";
      doc.head.prepend(policy);
      return "<!doctype html>\n" + doc.documentElement.outerHTML;
    }
  }

  window.OfflineEpub = { Zip, resolve, metadata, crc32 };
  window.offlineLibrary = new OfflineLibrary();
})();
