// Dev notes: shift+click any element to file a ticket on the board.
// Loaded in dev only. Everything renders inside one Shadow DOM root, and the
// only global is window.Devnotes.
(() => {
  if (window.Devnotes) return;
  const BOARD = (() => { try { return new URL(document.currentScript.src).origin; } catch { return "http://localhost:8090"; } })();
  // <script data-area="web" ...> sets the area of new notes; otherwise the board picks its first area.
  const AREA = document.currentScript?.dataset.area || undefined;
  const store = {
    get(k) { try { return localStorage.getItem("devnotes." + k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem("devnotes." + k, v); } catch {} },
  };

  // ---- pure helpers ----
  function selectorFor(el) {
    const unique = (s) => { try { return document.querySelectorAll(s).length === 1; } catch { return false; } };
    const attr = (n, v) => `[${n}="${String(v).replace(/["\\]/g, "\\$&")}"]`;
    const own = (e) => {
      const t = e.localName;
      if (e.id && !/\d{4,}|^[:_\d]|:/.test(e.id)) { const s = "#" + CSS.escape(e.id); if (unique(s)) return s; }
      for (const a of ["data-testid", "data-test", "aria-label"]) {
        const v = e.getAttribute(a); if (v) { const s = t + attr(a, v); if (unique(s)) return s; }
      }
      const role = e.getAttribute("role"); if (role) { const s = t + attr("role", role); if (unique(s)) return s; }
      return null;
    };
    const parts = [];
    for (let e = el; e && e.nodeType === 1 && e !== document.documentElement; e = e.parentElement) {
      const s = own(e);
      if (s) { parts.unshift(s); break; }
      let seg = e.localName;
      const p = e.parentElement;
      if (p) {
        const same = [...p.children].filter((c) => c.localName === e.localName);
        if (same.length > 1) seg += `:nth-of-type(${same.indexOf(e) + 1})`;
      }
      parts.unshift(seg);
      // Unanchored paths need some depth, or one new sibling elsewhere breaks them.
      if (parts.length >= 3 && unique(parts.join(" > "))) break;
    }
    return parts.join(" > ");
  }
  function parseNote(text, feature) {
    const lines = text.trim().split("\n");
    let title = lines[0].trim(), type = feature ? "feature" : "bug";
    const m = title.match(/^(feat|feature|bug)\s*:\s*/i);
    if (m) { type = /^b/i.test(m[1]) ? "bug" : "feature"; title = title.slice(m[0].length); }
    return { title, body: lines.slice(1).join("\n").trim(), type };
  }
  function place(r, w, h, vw, vh) {
    let left = r.right + 12, top = r.top;
    if (left + w > vw - 8) left = r.left - w - 12;
    if (left < 8) { left = r.left; top = r.bottom + 12; if (top + h > vh - 8) top = r.top - h - 12; }
    return { left: Math.max(8, Math.min(left, vw - w - 8)), top: Math.max(8, Math.min(top, vh - h - 8)) };
  }
  const elementText = (el) => (el.innerText || el.textContent || el.getAttribute("aria-label") || el.getAttribute("alt") || el.value || "").replace(/\s+/g, " ").trim().slice(0, 120);
  const openStatus = (s) => s !== "done" && s !== "wontfix";
  // Lucide icons (ISC), one per status, so status never rests on color alone.
  const ICONS = {
    inbox: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="1"/>',
    todo: '<circle cx="12" cy="12" r="10"/>',
    doing: '<path d="M10.1 2.182a10 10 0 0 1 3.8 0"/><path d="M13.9 21.818a10 10 0 0 1-3.8 0"/><path d="M17.609 3.721a10 10 0 0 1 2.69 2.7"/><path d="M2.182 13.9a10 10 0 0 1 0-3.8"/><path d="M20.279 17.609a10 10 0 0 1-2.7 2.69"/><path d="M21.818 10.1a10 10 0 0 1 0 3.8"/><path d="M3.721 6.391a10 10 0 0 1 2.7-2.69"/><path d="M6.391 20.279a10 10 0 0 1-2.69-2.7"/>',
    review: '<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/>',
    done: '<path d="M20 6 9 17l-5-5"/>',
    wontfix: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  };
  const icon = (s) => `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[s] || ICONS.inbox}</svg>`;

  async function api(method, path, body, raw) {
    const r = await fetch(BOARD + path, {
      method, body: raw || (body ? JSON.stringify(body) : undefined),
      headers: raw ? { "Content-Type": raw.type || "image/png" } : body ? { "Content-Type": "application/json" } : {},
    });
    if (!r.ok) throw new Error((await r.text()).trim() || r.statusText);
    return r.json();
  }

  // ---- shadow root ----
  const host = document.createElement("dev-notes");
  host.style.cssText = "all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647;display:block;";
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `<style>
:host { --on:#fff; --ink:#1A1C2B; --paper:#fff; --note:#DCE2FD; --raspberry:#3550F0; --cherry:#E8344E; --graphite:#5D6274; --line:#C9D1F5; --text:#1A1C2B; }
@media (prefers-color-scheme: dark) { :host { --paper:#1D1F2D; --note:#262D55; --raspberry:#6F82FF; --cherry:#FF5A70; --graphite:#A3A8BC; --line:#3A4272; --text:#E7E9F2; --on:#0F1019; } }
* { box-sizing: border-box; }
div, button, a, textarea, select, label { font: 500 13px/1.4 system-ui, -apple-system, sans-serif; color: var(--text); }
button { cursor: pointer; }
:focus-visible { outline: 2px solid var(--raspberry); outline-offset: 2px; }
[hidden] { display: none !important; }
.ui { pointer-events: auto; position: fixed; }
#hl { position: fixed; pointer-events: none; border: 2px solid var(--raspberry); border-radius: 4px; background: color-mix(in srgb, var(--raspberry) 8%, transparent); box-shadow: 0 0 0 4px color-mix(in srgb, var(--raspberry) 18%, transparent); }
#hl.solid { border-style: solid; background: transparent; }
#note { width: 300px; background: var(--note); border-radius: 4px 14px 14px 14px; box-shadow: 0 10px 30px rgba(15,16,25,.22), 0 1px 0 var(--line) inset; padding: 12px 12px 10px; }
#note::before { content: ""; position: absolute; left: -5px; top: -5px; width: 12px; height: 12px; border-radius: 50%; background: var(--raspberry); box-shadow: 0 1px 2px rgba(0,0,0,.3); }
#note textarea { width: 100%; min-height: 76px; resize: vertical; border: 0; background: transparent; font-size: 15px; line-height: 1.45; outline: none; padding: 0; }
#note textarea::placeholder { color: var(--graphite); }
.row { display: flex; align-items: center; gap: 8px; margin-top: 8px; }
.seg { display: inline-flex; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
.seg button { border: 0; background: transparent; padding: 3px 10px; font-weight: 600; }
.seg button[aria-pressed=true] { background: var(--raspberry); color: var(--on); }
.hint { color: var(--graphite); font-size: 12px; margin-left: auto; }
.err { color: var(--cherry); font-size: 12px; margin-top: 6px; }
.pin { --c: #5D6274; display: inline-flex; align-items: center; gap: 3px; min-width: 22px; height: 22px; padding: 0 6px 0 5px; border-radius: 11px 11px 11px 3px; border: 2px solid #fff; background: var(--c); color: #fff; font-weight: 700; font-size: 11px; box-shadow: 0 2px 6px rgba(15,16,25,.3); transition: opacity .16s ease, transform .16s ease; }
.pin svg, .st svg, .btn svg { flex: none; }
.pin.gone { opacity: 0; transform: scale(.7); }
/* Muted status colors: white text on each passes 4.5:1, on light and dark pages alike. */
.s-todo { --c: #3550F0; } .s-doing { --c: #A35A00; } .s-review { --c: #7B3FC4; } .s-done { --c: #2E7D4F; } .s-wontfix { --c: #6B6F80; }
.st { display: inline-flex; align-items: center; gap: 4px; padding: 1px 7px 1px 5px; border-radius: 999px; font-size: 12px; font-weight: 600; color: var(--c, #5D6274); background: color-mix(in srgb, var(--c, #5D6274) 12%, transparent); }
@media (prefers-color-scheme: dark) { .st { color: color-mix(in srgb, var(--c, #5D6274) 45%, #fff); } }
.btn { display: inline-flex; align-items: center; gap: 5px; flex: none; }
@media (prefers-reduced-motion: reduce) { .pin { transition: none; } }
#card { width: 300px; background: var(--paper); border-radius: 12px; border: 1px solid var(--line); box-shadow: 0 10px 30px rgba(15,16,25,.22); padding: 12px; }
#card h4 { margin: 0 0 4px; font: 700 14px/1.35 system-ui, sans-serif; color: var(--text); }
#card .meta { color: var(--graphite); font-size: 12px; }
#card .body { margin-top: 8px; max-height: 120px; overflow: auto; white-space: pre-wrap; }
#card select, #card textarea { width: 100%; border: 1px solid var(--line); border-radius: 8px; background: var(--paper); padding: 5px 8px; }
#card textarea { min-height: 52px; resize: vertical; margin-top: 8px; }
.btn { border: 1px solid var(--line); background: var(--paper); border-radius: 8px; padding: 4px 10px; font-weight: 600; text-decoration: none; }
.btn.primary { background: var(--raspberry); border-color: var(--raspberry); color: var(--on); }
/* A small tab on the right edge, halfway up, clear of composers and toolbars. */
#fab { right: 0; top: 50%; transform: translateY(-50%); width: 24px; height: 44px; border-radius: 10px 0 0 10px; opacity: .85; border: 0; background: var(--ink); color: #fff; font-weight: 700; font-size: 12px; box-shadow: 0 4px 14px rgba(15,16,25,.3); display: grid; place-items: center; padding: 0; }
#fab.has { background: var(--raspberry); }
#fab:hover, #fab:focus-visible { opacity: 1; width: 30px; }
#menu { right: 34px; top: 50%; transform: translateY(-50%); width: 250px; background: var(--paper); border: 1px solid var(--line); border-radius: 12px; box-shadow: 0 10px 30px rgba(15,16,25,.22); padding: 6px; }
#menu button, #menu a, #menu label { display: flex; align-items: center; gap: 8px; width: 100%; padding: 7px 8px; border: 0; background: none; border-radius: 8px; text-decoration: none; text-align: left; }
#menu button:hover, #menu a:hover, #menu label:hover { background: color-mix(in srgb, var(--raspberry) 10%, transparent); }
#menu .tip { padding: 8px; color: var(--graphite); font-size: 12px; border-top: 1px solid var(--line); margin-top: 4px; }
#toast { right: 34px; top: calc(50% + 30px); background: var(--ink); color: #fff; border-radius: 10px; padding: 8px 12px; display: flex; gap: 10px; align-items: center; box-shadow: 0 6px 20px rgba(15,16,25,.3); }
#toast span { color: #fff; } #toast a { color: #AEBBFF; font-weight: 600; }
kbd { font: 600 11px/1 ui-monospace, monospace; border: 1px solid var(--line); border-radius: 4px; padding: 1px 4px; }
</style>
<div id="hl" hidden></div>
<div id="pins"></div>
<div id="note" class="ui" role="dialog" aria-label="New note" hidden>
  <textarea id="text" aria-label="Note" placeholder="What is wrong here? First line becomes the title. Paste or drop an image to attach it."></textarea>
  <div class="row">
    <span class="seg" role="group" aria-label="Kind"><button type="button" id="k-bug" aria-pressed="true">Bug</button><button type="button" id="k-feat" aria-pressed="false">Feature</button></span>
    <span class="hint"><kbd>Enter</kbd> save <kbd>Esc</kbd> cancel</span>
  </div>
  <div class="hint" id="note-imgs" hidden></div>
  <div class="err" id="note-err" hidden></div>
</div>
<div id="card" class="ui" role="dialog" aria-label="Note" hidden></div>
<div id="menu" class="ui" hidden>
  <button type="button" id="m-pins"></button>
  <a id="m-board" target="_blank" rel="noopener">Open the board</a>
  <label><input type="checkbox" id="m-shots"> Attach screenshots</label>
  <div class="tip"><kbd>Shift</kbd>+click anything to drop a note. <kbd>Shift</kbd>+<kbd>D</kbd> hides all of this.</div>
</div>
<button id="fab" class="ui" type="button" aria-label="Dev notes"></button>
<div id="toast" class="ui" role="status" hidden></div>`;
  const $ = (id) => root.getElementById(id);
  // Keep our typing and clicks away from the host app's handlers.
  for (const t of ["keydown", "keyup", "keypress", "input", "click", "mousedown", "pointerdown", "mouseup", "pointerup", "dblclick", "paste", "dragover", "drop"]) root.addEventListener(t, (e) => e.stopPropagation());

  let enabled = store.get("off") !== "1";
  let pinsOn = store.get("pins") !== "0";
  let notes = [];
  let target = null, feature = false, stream = null, mx = 0, my = 0;
  const inOverlay = (e) => e.composedPath().includes(host);

  // ---- highlight ----
  function highlight(el) {
    const hl = $("hl");
    if (!el || !enabled || !pinsOn) { hl.hidden = true; return; }
    const r = el.getBoundingClientRect();
    Object.assign(hl.style, { left: r.left - 3 + "px", top: r.top - 3 + "px", width: r.width + 6 + "px", height: r.height + 6 + "px" });
    hl.hidden = false;
  }
  const noteOpen = () => !$("note").hidden;

  // ---- sticky note ----
  function setKind(f) { feature = f; if (target && $("text").value) $("text").dispatchEvent(new Event("input")); $("k-bug").setAttribute("aria-pressed", !f); $("k-feat").setAttribute("aria-pressed", f); }
  $("k-bug").onclick = () => { setKind(false); $("text").focus(); };
  $("k-feat").onclick = () => { setKind(true); $("text").focus(); };
  function openNote(el) {
    target = el; hideCard(); highlight(el); $("menu").hidden = true;
    $("note-err").hidden = true;
    setKind(false);
    $("note").hidden = false;
    positionNote();
    $("text").focus();
  }
  function positionNote() {
    if (!target) return;
    const p = place(target.getBoundingClientRect(), 300, $("note").offsetHeight || 150, innerWidth, innerHeight);
    Object.assign($("note").style, { left: p.left + "px", top: p.top + "px" });
  }
  function closeNote() { $("note").hidden = true; $("text").value = ""; target = null; highlight(null); queue([]); store.set("draft", ""); }

  // The draft survives a reload (dev servers reload often). Images are not kept.
  $("text").addEventListener("input", () => {
    if (target) store.set("draft", JSON.stringify({ url: location.href, sel: selectorFor(target), text: $("text").value, feature }));
  });
  function restoreDraft() {
    let d; try { d = JSON.parse(store.get("draft") || "null"); } catch {}
    if (!d || d.url !== location.href || !d.text) return;
    openNote(findEl(d.sel) || document.body);
    setKind(!!d.feature);
    $("text").value = d.text;
  }

  // Pasted or dropped images: queued on a new note, uploaded right away on an open card.
  let queued = [], cardId = null;
  const imagesIn = (dt) => [...(dt?.files || [])].filter((f) => /^image\/(png|jpeg|webp)$/.test(f.type));
  function takeImages(el, onFiles) {
    const files = (dt) => !!dt && [...dt.types].includes("Files");
    el.addEventListener("paste", (e) => { const f = imagesIn(e.clipboardData); if (f.length) { e.preventDefault(); onFiles(f); } });
    el.addEventListener("dragover", (e) => { if (files(e.dataTransfer)) e.preventDefault(); });
    el.addEventListener("drop", (e) => { if (files(e.dataTransfer)) { e.preventDefault(); onFiles(imagesIn(e.dataTransfer)); } });
  }
  function queue(f) {
    queued = f;
    $("note-imgs").textContent = f.length === 1 ? "1 image attached" : f.length + " images attached";
    $("note-imgs").hidden = !f.length;
  }
  takeImages($("note"), (f) => { queue([...queued, ...f]); $("text").focus(); });
  takeImages($("card"), async (f) => {
    const id = cardId;
    for (const x of f) await api("POST", `/api/tickets/${id}/screenshot`, null, x).catch(() => {});
    if (f.length) toast(id, `Added ${f.length === 1 ? "an image" : f.length + " images"} to #${id}`);
  });
  $("text").addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); closeNote(); }
    else if (e.key === "Enter" && (!e.shiftKey || e.metaKey || e.ctrlKey)) { e.preventDefault(); save(); }
  });
  async function save() {
    const text = $("text").value;
    if ((!text.trim() && !queued.length) || !target) return;
    const n = parseNote(text, feature), el = target, rect = el.getBoundingClientRect(), files = queued;
    const ticket = {
      title: n.title || "Screenshot", body: n.body, type: n.type, status: "inbox", priority: "p2", area: AREA, source: "devnote",
      url: location.href, selector: selectorFor(el), element_text: elementText(el), viewport: innerWidth + "x" + innerHeight,
    };
    $("note").hidden = true;
    // Start the capture now, while the keypress still counts as a user
    // gesture, but never let a pending permission prompt hold up the ticket.
    const shot = store.get("shots") === "1" ? grab(rect).catch(() => null) : null;
    try {
      const t = await api("POST", "/api/tickets", ticket);
      closeNote();
      const png = await shot;
      toast(t.id);
      loadPins();
      for (const img of png ? [...files, png] : files) await api("POST", `/api/tickets/${t.id}/screenshot`, null, img).catch(() => {});
    } catch (err) {
      $("note").hidden = false; positionNote();
      $("note-err").textContent = `Not saved: ${BOARD} did not answer (${err.message}). Is the board running?`;
      $("note-err").hidden = false;
    }
  }

  // Screenshots: getDisplayMedia asks permission, so it only runs when the
  // user turns it on. The stream is kept for the session so they are asked once.
  const within = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(r, ms))]);
  async function grab(rect) {
    if (!stream || !stream.active) {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: { displaySurface: "browser" }, audio: false, preferCurrentTab: true, selfBrowserSurface: "include" });
      stream.getVideoTracks()[0].addEventListener("ended", () => { stream = null; });
    }
    const v = document.createElement("video");
    v.muted = true; v.srcObject = stream;
    const c = document.createElement("canvas");
    // Hide our pins, then wait for a frame painted after that (each step
    // gives up after a moment: a still page sends no new frames).
    host.style.visibility = "hidden";
    try {
      await within(v.play(), 1000);
      await within(new Promise((r) => v.requestVideoFrameCallback(() => v.requestVideoFrameCallback(r))), 600);
      if (!v.videoWidth) throw new Error("no video frame");
      const sx = v.videoWidth / innerWidth, sy = v.videoHeight / innerHeight, pad = 160;
      const x = Math.max(0, rect.left - pad), y = Math.max(0, rect.top - pad);
      const w = Math.min(innerWidth, rect.right + pad) - x, h = Math.min(innerHeight, rect.bottom + pad) - y;
      c.width = Math.max(1, Math.round(w * sx)); c.height = Math.max(1, Math.round(h * sy));
      c.getContext("2d").drawImage(v, x * sx, y * sy, w * sx, h * sy, 0, 0, c.width, c.height);
    } finally {
      host.style.visibility = "";
      v.pause(); v.srcObject = null;
    }
    return new Promise((r) => c.toBlob(r, "image/png"));
  }

  let toastTimer;
  function toast(id, text) {
    const t = $("toast");
    t.innerHTML = "";
    const s = document.createElement("span"); s.textContent = text || `Ticket #${id} created`;
    const a = document.createElement("a"); a.href = `${BOARD}/#t=${id}`; a.target = "_blank"; a.rel = "noopener"; a.textContent = "Open on board";
    t.append(s, a); t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 5000);
  }

  // ---- pins ----
  async function loadPins() {
    if (!enabled) return;
    try {
      notes = (await api("GET", "/api/tickets?url=" + encodeURIComponent(location.href))).filter((t) => openStatus(t.status));
    } catch { notes = []; }
    renderPins();
  }
  function findEl(sel) { try { return sel ? document.querySelector(sel) : null; } catch { return null; } }
  function renderPins() {
    const box = $("pins");
    box.innerHTML = "";
    $("fab").textContent = notes.length || "+";
    $("fab").classList.toggle("has", notes.length > 0);
    $("fab").setAttribute("aria-label", `Dev notes: ${notes.length} open on this page`);
    if (!pinsOn || !enabled) return;
    for (const t of notes) {
      const b = document.createElement("button");
      b.className = `pin ui s-${t.status}`; b.type = "button"; b.innerHTML = icon(t.status); b.append(t.id); b.dataset.id = t.id;
      b.setAttribute("aria-label", `Note #${t.id}, ${t.status}: ${t.title}`); b.title = `${t.status}: ${t.title}`;
      b.onclick = () => showCard(t, b);
      box.append(b);
    }
    positionPins();
  }
  function positionPins() {
    for (const b of $("pins").children) {
      const t = notes.find((n) => String(n.id) === b.dataset.id);
      const el = t && findEl(t.selector), r = el && el.getBoundingClientRect();
      if (!r || (!r.width && !r.height) || r.bottom < 0 || r.top > innerHeight) { b.hidden = true; continue; }
      b.hidden = false;
      b.style.left = Math.min(innerWidth - 40, Math.max(2, r.right - 12)) + "px";
      b.style.top = Math.max(2, r.top - 12) + "px";
    }
    if (noteOpen()) { highlight(target); positionNote(); }
  }
  let raf = 0;
  const schedule = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; positionPins(); }); };
  addEventListener("scroll", schedule, { capture: true, passive: true });
  addEventListener("resize", schedule, { passive: true });
  setInterval(schedule, 1000); // the app may re-render under a pin
  setInterval(() => { if (!document.hidden) loadPins(); }, 15000);

  function hideCard() { $("card").hidden = true; }
  function showCard(t, pin) {
    const c = $("card"); cardId = t.id;
    c.innerHTML = "";
    const h = document.createElement("h4"); h.textContent = t.title;
    const meta = document.createElement("div"); meta.className = "meta row";
    const st = document.createElement("span"); st.className = `st s-${t.status}`; st.innerHTML = icon(t.status); st.append(t.status);
    meta.append(st, `#${t.id}, ${t.type}, ${t.priority}`); meta.style.marginTop = "0";
    const body = document.createElement("div"); body.className = "body"; body.textContent = t.body || ""; body.hidden = !t.body;
    const sel = document.createElement("select"); sel.setAttribute("aria-label", "Status");
    for (const s of ["inbox", "todo", "doing", "review", "done", "wontfix"]) sel.append(new Option(s, s, false, s === t.status));
    const note = document.createElement("textarea"); note.placeholder = "Add a note"; note.setAttribute("aria-label", "Add a note");
    const err = document.createElement("div"); err.className = "err"; err.hidden = true;
    const row = document.createElement("div"); row.className = "row";
    const statusRow = document.createElement("div"); statusRow.className = "row"; statusRow.append(sel);
    const add = document.createElement("button"); add.className = "btn primary"; add.type = "button"; add.textContent = "Add note";
    const open = document.createElement("a"); open.className = "btn"; open.href = `${BOARD}/#t=${t.id}`; open.target = "_blank"; open.rel = "noopener"; open.textContent = "Open on board";
    row.append(add, open);
    if (t.status === "review") {
      const done = document.createElement("button"); done.className = "btn primary"; done.type = "button"; done.innerHTML = icon("done"); done.append("Done");
      done.onclick = async () => {
        done.disabled = true;
        try {
          await api("PATCH", `/api/tickets/${t.id}`, { status: "done" });
          hideCard();
          // Done pins are hidden: fade this one out, then refresh.
          const p = $("pins").querySelector(`[data-id="${t.id}"]`);
          if (p) p.classList.add("gone");
          setTimeout(loadPins, matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 160);
        } catch (e) { done.disabled = false; fail(e); }
      };
      statusRow.prepend(done);
    }
    c.append(h, meta, body, statusRow, note, row, err);
    const fail = (e) => { err.textContent = e.message; err.hidden = false; };
    sel.onchange = async () => {
      try { const u = await api("PATCH", `/api/tickets/${t.id}`, { status: sel.value }); if (!openStatus(u.status)) hideCard(); loadPins(); } catch (e) { fail(e); }
    };
    add.onclick = async () => {
      if (!note.value.trim()) return;
      try { await api("POST", `/api/tickets/${t.id}/notes`, { text: note.value, by: "human" }); note.value = ""; add.textContent = "Added"; setTimeout(() => { add.textContent = "Add note"; }, 1500); } catch (e) { fail(e); }
    };
    c.hidden = false;
    const p = place(pin.getBoundingClientRect(), 300, c.offsetHeight, innerWidth, innerHeight);
    Object.assign(c.style, { left: p.left + "px", top: p.top + "px" });
    (statusRow.querySelector("button") || sel).focus();
    const el = findEl(t.selector); if (el) { highlight(el); setTimeout(() => { if (!noteOpen()) highlight(null); }, 1500); }
  }

  // ---- floating button and menu ----
  function syncMenu() {
    $("m-pins").textContent = pinsOn ? "Hide pins" : "Show pins";
    $("m-board").href = BOARD + "/";
    $("m-shots").checked = store.get("shots") === "1";
  }
  $("fab").onclick = () => { $("menu").hidden = !$("menu").hidden; store.set("seen", "1"); syncMenu(); };
  $("m-pins").onclick = () => { pinsOn = !pinsOn; store.set("pins", pinsOn ? "1" : "0"); syncMenu(); renderPins(); };
  $("m-shots").onchange = () => {
    store.set("shots", $("m-shots").checked ? "1" : "0");
    if (!$("m-shots").checked && stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
  };

  function setEnabled(on) {
    enabled = on; store.set("off", on ? "0" : "1");
    for (const id of ["fab", "pins"]) $(id).hidden = !on;
    if (!on) { closeNote(); hideCard(); $("menu").hidden = true; $("toast").hidden = true; }
    else loadPins();
  }

  // ---- page events ----
  const editable = (e) => { const t = e.composedPath()[0]; return t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)); };
  addEventListener("keydown", (e) => {
    if (e.key === "Shift" && enabled && !noteOpen()) { const el = document.elementFromPoint(mx, my); if (el && el !== host) highlight(el); }
    if ((e.key === "D" || e.key === "d") && e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey && !editable(e)) { e.preventDefault(); setEnabled(!enabled); }
    if (e.key === "Escape" && !$("card").hidden) hideCard();
  }, true);
  addEventListener("keyup", (e) => { if (e.key === "Shift" && !noteOpen()) highlight(null); }, true);
  addEventListener("mousemove", (e) => {
    mx = e.clientX; my = e.clientY;
    if (!enabled || noteOpen()) return;
    if (e.shiftKey && !inOverlay(e)) highlight(e.target); else if (!$("hl").hidden) highlight(null);
  }, { capture: true, passive: true });
  const block = (e) => {
    if (!enabled || !pinsOn || !e.shiftKey || e.button !== 0 || inOverlay(e)) return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (e.type === "click") openNote(e.target);
  };
  for (const t of ["pointerdown", "mousedown", "pointerup", "mouseup", "click", "dblclick"]) addEventListener(t, block, true);
  addEventListener("click", (e) => {
    if (inOverlay(e)) return;
    if (!$("card").hidden) hideCard();
    if (!$("menu").hidden) $("menu").hidden = true;
  }, true);

  // SPA navigation: reload pins after the route changes.
  let navTimer;
  const onNav = () => { clearTimeout(navTimer); navTimer = setTimeout(loadPins, 300); };
  for (const m of ["pushState", "replaceState"]) {
    const orig = history[m];
    history[m] = function (...args) { const r = orig.apply(this, args); onNav(); return r; };
  }
  addEventListener("popstate", onNav);
  addEventListener("hashchange", onNav);

  // A modal dialog makes everything outside it inert, and clicks on inert
  // nodes land on its backdrop and close it. So while one is open, live inside
  // it, as a manual popover so we stay in the top layer above it.
  host.popover = "manual";
  function rehome() {
    const parent = [...document.querySelectorAll("dialog:modal")].pop() || document.documentElement;
    if (host.parentNode === parent) return;
    parent.appendChild(host);
    host.showPopover();
    if (noteOpen()) $("text").focus();
  }
  function mount() {
    rehome();
    new MutationObserver(rehome).observe(document.documentElement, { childList: true, subtree: true, attributeFilter: ["open"] });
    syncMenu();
    setEnabled(enabled);
    if (enabled) restoreDraft();
    if (enabled && store.get("seen") !== "1") { $("menu").hidden = false; store.set("seen", "1"); }
  }
  if (document.body) mount(); else addEventListener("DOMContentLoaded", mount);

  window.Devnotes = { board: BOARD, toggle: () => setEnabled(!enabled), reload: loadPins, _: { selectorFor, parseNote, place } };
})();
