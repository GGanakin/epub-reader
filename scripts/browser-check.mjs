// Mobile EPUB integration checks, with an isolated temporary library.
// Requires Node 22+, Python 3 and Google Chrome; no npm dependencies.
import assert from 'node:assert/strict';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

const project = path.resolve(import.meta.dirname, '..');
const serverData = await mkdtemp(path.join(tmpdir(), 'epub-qa-'));
const server = spawn(process.env.PYTHON_BIN || 'python3', [path.join(project, 'server.py'), '--port', '0', '--data-dir', serverData], {stdio: ['ignore', 'pipe', 'pipe']});
const baseURL = await new Promise((resolve, reject) => {
  let output = '';
  const timer = setTimeout(() => reject(new Error('Server did not start')), 10000);
  server.once('error', error => {clearTimeout(timer); reject(error);});
  server.once('exit', code => {clearTimeout(timer); reject(new Error(`Server exited: ${code}`));});
  server.stdout.on('data', data => {output += data; const match = output.match(/http:\/\/127\.0\.0\.1:\d+/); if (match) {clearTimeout(timer); resolve(match[0]);}});
  server.stderr.on('data', () => {});
});
process.on('exit', () => server.kill());
const browserProfile = await mkdtemp(path.join(tmpdir(), 'epub-browser-'));
const browser = spawn(process.env.CHROME_BIN || 'google-chrome', [
  '--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
  '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
  '--disable-component-update', '--disable-sync', '--disable-extensions',
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows', '--remote-debugging-port=0',
  `--user-data-dir=${browserProfile}`, 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });
const debuggerURL = await new Promise((resolve, reject) => {
  let output = '';
  const timer = setTimeout(() => { browser.kill(); reject(new Error('Chrome did not start in 20 seconds')); }, 20000);
  browser.once('error', error => { clearTimeout(timer); reject(error); });
  browser.once('exit', code => { clearTimeout(timer); reject(new Error(`Chrome exited early (${code})`)); });
  browser.stderr.on('data', data => {
    output += data.toString();
    const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/);
    if (match) { clearTimeout(timer); resolve(match[1]); }
  });
});
const socket = new WebSocket(debuggerURL);
await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
let commandId = 0;
let sessionId;
const pending = new Map();
const errors = [];
socket.addEventListener('message', event => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    const { resolve, reject, timer } = pending.get(message.id);
    clearTimeout(timer);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
  } else if (message.sessionId === sessionId && message.method === 'Runtime.exceptionThrown') {
    errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
  }
});
function send(method, params = {}, targetSession = sessionId) {
  return new Promise((resolve, reject) => {
    const id = ++commandId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timed out: ${method}`)); }, 25000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params, ...(targetSession ? { sessionId: targetSession } : {}) }));
  });
}
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(expression, description, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return;
    await delay(70);
  }
  throw new Error(`Timeout waiting for ${description}`);
}
async function click(selector) {
  const target = JSON.stringify(selector);
  await evaluate(`document.querySelector(${target}).scrollIntoView({block:'center', inline:'nearest', behavior:'instant'})`);
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const point = await evaluate(`(() => { const el = document.querySelector(${target}); const r = el.getBoundingClientRect(); return {x:r.x+r.width/2-visualViewport.offsetLeft, y:r.y+r.height/2-visualViewport.offsetTop, disabled:el.disabled, visible:r.width>0&&r.height>0}; })()`);
  assert.equal(point.visible, true, `${selector} must be visible`);
  assert.ok(!point.disabled, `${selector} must be enabled`);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  await delay(100);
}
async function key(key, code = key) {
  const keyCodes = { Escape: 27, Tab: 9, ArrowLeft: 37, ArrowRight: 39 };
  const virtualKey = keyCodes[key] || 0;
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: virtualKey, nativeVirtualKeyCode: virtualKey });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: virtualKey, nativeVirtualKeyCode: virtualKey });
  await delay(70);
}
async function screenshot(filename, fullPage = false) {
  if (fullPage) {
    await evaluate(`Promise.all([...document.images].filter(img => !img.closest('dialog')).map(img => { img.loading = 'eager'; return img.decode().catch(() => {}); }))`);
  }
  const metrics = await send('Page.getLayoutMetrics');
  const clip = fullPage ? { x: 0, y: 0, width: metrics.cssContentSize.width, height: Math.min(6000, metrics.cssContentSize.height), scale: 1 } : undefined;
  const result = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: fullPage, ...(clip ? { clip } : {}) });
  await writeFile(filename, Buffer.from(result.data, 'base64'));
}
async function check(name, task) {
  await task();
  console.log(`✓ ${name}`);
}
async function noOverflow() {
  assert.equal(await evaluate('document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1'), true, 'no horizontal page overflow');
}

const context = await send('Target.createBrowserContext', {}, null);
async function viewport(width, height, mobile = true) {
  await send('Emulation.setDeviceMetricsOverride', {width, height, deviceScaleFactor: 1, mobile});
  await send('Emulation.setTouchEmulationEnabled', {enabled: mobile});
  await delay(180);
}
async function touch(selector) {
  await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'nearest'})`);
  const point = await evaluate(`(() => {const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  await send('Input.dispatchTouchEvent', {type:'touchStart', touchPoints:[point]});
  await send('Input.dispatchTouchEvent', {type:'touchEnd', touchPoints:[]});
  await delay(120);
}
const readerReady = 'document.querySelector("#reader-view") && !document.querySelector("#reader-view").hidden && document.querySelector("#chapter-loading").hidden && !document.querySelector("#bookmark-button").disabled';
try {
  const target = await send('Target.createTarget', {url:'about:blank', browserContextId:context.browserContextId}, null);
  ({sessionId} = await send('Target.attachToTarget', {targetId:target.targetId, flatten:true}, null));
  await send('Page.enable'); await send('Runtime.enable');
  await viewport(390, 844);
  await send('Page.navigate', {url:baseURL});
  await waitFor('document.readyState === "complete" && !!document.querySelector("#first-import")', 'empty shelf');
  await screenshot('/tmp/epub-mobile-shelf.png');
  await check('Empty shelf fits narrow phones and touch controls stay at least 44px', async () => {
    for (const width of [320, 360, 390, 430]) {
      await viewport(width, 844); await noOverflow();
      const controls = await evaluate('["menu-button","appearance-button","import-button","first-import"].map(id=>{const r=document.getElementById(id).getBoundingClientRect();return {id,w:r.width,h:r.height,right:r.right};})');
      for (const control of controls) {assert.ok(control.w >= 44 && control.h >= 44, control.id); assert.ok(control.right <= width, control.id);}
    }
  });
  await viewport(390, 844);
  await check('Phone file picker imports a real EPUB through the HTTP API', async () => {
    const {root} = await send('DOM.getDocument');
    const {nodeId} = await send('DOM.querySelector', {nodeId:root.nodeId, selector:'#file-input'});
    await send('DOM.setFileInputFiles', {nodeId, files:[path.join(project,'examples/在纸页之间.epub')]});
    await waitFor(readerReady, 'uploaded EPUB chapter');
    assert.equal(await evaluate('document.querySelector("#view-title").textContent'), '在纸页之间');
    assert.equal(await evaluate('window.__epub_script_executed'), undefined);
    assert.equal((await (await fetch(`${baseURL}/api/books`)).json()).length, 1);
  });
  await evaluate('document.querySelector("#toast").hidden = true');
  await screenshot('/tmp/epub-mobile-reader.png');
  await check('Touch opens the directory, navigates chapters and releases the page', async () => {
    await touch('#menu-button');
    assert.equal(await evaluate('document.querySelector("#main-content").inert'), true);
    await touch('.toc-item:nth-child(3)');
    await waitFor(readerReady, 'second chapter');
    assert.ok((await evaluate('document.querySelector("#chapter-label").textContent')).startsWith('02'));
    assert.equal(await evaluate('document.querySelector("#main-content").inert'), false);
    await touch('#next-button'); await waitFor(readerReady, 'next chapter');
    assert.ok((await evaluate('document.querySelector("#chapter-label").textContent')).startsWith('03'));
  });
  await check('Touch scroll moves real chapter text and saves progress', async () => {
    const point = await evaluate('(() => {const r=document.querySelector("#reader-frame").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height*.75};})()');
    await send('Input.dispatchTouchEvent', {type:'touchStart',touchPoints:[point]});
    for (let step=1;step<=8;step++) {await send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:point.x,y:point.y-step*35}]});await delay(25);}
    await send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    await waitFor('document.querySelector("#reader-frame").contentDocument.scrollingElement.scrollTop > 50', 'chapter scroll');
    await delay(800);
    assert.ok(await evaluate('Object.values(JSON.parse(localStorage.getItem("paper-reader-v1")).books)[0].progress.ratio > 0'));
  });
  await check('Bottom settings sheet changes theme and font, dismisses, and retains position', async () => {
    await touch('#appearance-button');
    await touch('[data-theme="dark"].theme-option');
    await evaluate('document.querySelector("#font-size").value=24;document.querySelector("#font-size").dispatchEvent(new Event("input",{bubbles:true}))');
    assert.equal(await evaluate('getComputedStyle(document.querySelector("#reader-frame").contentDocument.body).fontSize'), '24px');
    assert.equal(await evaluate('document.querySelector("meta[name=theme-color]").content'), '#202620');
    await screenshot('/tmp/epub-mobile-settings.png');
    await touch('#close-settings');
    assert.equal(await evaluate('document.querySelector("#main-content").inert'), false);
    assert.ok(await evaluate('document.querySelector("#reader-frame").contentDocument.scrollingElement.scrollTop > 0'));
  });
  await check('Bookmarks and reading position survive a real browser reload', async () => {
    await touch('#bookmark-button');
    await evaluate('document.querySelector("#bookmark-note").value="手机阅读测试"');
    await touch('#bookmark-form button[type=submit]');
    const before = await evaluate('Object.values(JSON.parse(localStorage.getItem("paper-reader-v1")).books)[0].progress');
    await send('Page.reload'); await waitFor(readerReady, 'restored reader');
    const after = await evaluate('Object.values(JSON.parse(localStorage.getItem("paper-reader-v1")).books)[0]');
    assert.equal(after.bookmarks[0].note, '手机阅读测试');
    assert.equal(after.progress.href, before.href);
    assert.ok(Math.abs(after.progress.ratio-before.ratio)<.02);
  });
  await check('Two devices share books but keep progress, bookmarks and appearance separate', async () => {
    const firstSession = sessionId;
    const firstState = await evaluate('JSON.parse(localStorage.getItem("paper-reader-v1"))');
    const secondContext = await send('Target.createBrowserContext', {}, null);
    try {
      const secondTarget = await send('Target.createTarget', {url:'about:blank',browserContextId:secondContext.browserContextId}, null);
      ({sessionId} = await send('Target.attachToTarget', {targetId:secondTarget.targetId,flatten:true}, null));
      await send('Page.enable'); await send('Runtime.enable');
      // Same browser user agent and IP: isolation comes from browser storage.
      await viewport(390,844);
      await send('Page.navigate', {url:baseURL});
      await waitFor('document.querySelectorAll(".book-card").length === 1', 'shared book on second device');
      let secondState = await evaluate('JSON.parse(localStorage.getItem("paper-reader-v1"))');
      assert.deepEqual(secondState.books, {});
      assert.equal(secondState.settings.theme, 'paper');
      assert.equal(secondState.lastBook, null);
      await touch('.book-card'); await waitFor(readerReady, 'second device reading');
      secondState = await evaluate('JSON.parse(localStorage.getItem("paper-reader-v1"))');
      const secondBook = Object.values(secondState.books)[0];
      assert.equal(secondBook.progress.chapter, 0);
      assert.equal(secondBook.progress.ratio, 0);
      assert.deepEqual(secondBook.bookmarks, []);
      await touch('#bookmark-button');
      await evaluate('document.querySelector("#bookmark-note").value="第二台设备的书签"');
      await touch('#bookmark-form button[type=submit]');
      await send('Page.reload'); await waitFor(readerReady, 'second device restored');
      assert.equal(await evaluate('Object.values(JSON.parse(localStorage.getItem("paper-reader-v1")).books)[0].bookmarks[0].note'), '第二台设备的书签');
      sessionId = firstSession;
      const unchanged = await evaluate('JSON.parse(localStorage.getItem("paper-reader-v1"))');
      assert.deepEqual(unchanged.settings, firstState.settings);
      const firstBook = Object.values(firstState.books)[0];
      const stillFirst = Object.values(unchanged.books)[0];
      assert.deepEqual(stillFirst.bookmarks, firstBook.bookmarks);
      assert.equal(stillFirst.progress.href, firstBook.progress.href);
      assert.ok(Math.abs(stillFirst.progress.ratio-firstBook.progress.ratio)<.02);
    } finally {
      sessionId = firstSession;
      await send('Target.disposeBrowserContext', {browserContextId:secondContext.browserContextId}, null);
    }
  });
  await check('Phone focus mode expands the reader and has a working touch exit', async () => {
    const height = await evaluate('document.querySelector("#reader-frame").clientHeight');
    await touch('#focus-button');
    assert.ok(await evaluate(`document.querySelector("#reader-frame").clientHeight > ${height+80}`));
    await touch('#exit-focus');
    assert.equal(await evaluate('document.body.classList.contains("focus-mode")'), false);
  });
  await check('Reader fits small phones, landscape and desktop without horizontal overflow', async () => {
    for (const [width,height,mobile] of [[320,640,true],[360,740,true],[430,932,true],[740,360,true],[844,390,true],[1440,900,false]]) {
      await viewport(width,height,mobile); await noOverflow();
      assert.ok(await evaluate('document.querySelector("#reader-frame").clientHeight > 200'));
      assert.ok(await evaluate('(() => {const d=document.querySelector("#reader-frame").contentDocument;return d.documentElement.scrollWidth <= d.documentElement.clientWidth+1;})()'));
      if (width===1440) await screenshot('/tmp/epub-desktop-reader.png');
    }
  });
  await check('Returning to the shelf exposes the imported book', async () => {
    await viewport(390,844); await touch('#menu-button'); await touch('#shelf-button');
    assert.equal(await evaluate('document.querySelectorAll(".book-card").length'), 1);
    assert.equal(await evaluate('document.querySelector("#main-content").inert'), false);
    await screenshot('/tmp/epub-mobile-library.png');
  });
  await check('Refreshing the shelf keeps device reading records', async () => {
    const before = await evaluate('JSON.parse(localStorage.getItem("paper-reader-v1")).books');
    await touch('#refresh-library');
    await waitFor('!document.querySelector("#refresh-library").disabled', 'shelf refresh');
    assert.equal(await evaluate('document.querySelectorAll(".book-card").length'), 1);
    assert.deepEqual(await evaluate('JSON.parse(localStorage.getItem("paper-reader-v1")).books'), before);
    await noOverflow();
  });
  assert.deepEqual(errors, [], 'No uncaught JavaScript exceptions');
  console.log('All mobile EPUB browser checks passed. Screenshots: /tmp/epub-*.png');
} finally {
  await send('Target.disposeBrowserContext', {browserContextId:context.browserContextId}, null).catch(()=>{});
  await send('Browser.close', {}, null).catch(()=>{});
  socket.close(); browser.kill(); server.kill();
  await delay(250);
  await rm(browserProfile,{recursive:true,force:true});
  await rm(serverData,{recursive:true,force:true});
}
