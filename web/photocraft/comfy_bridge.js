// ComfyUI ↔ PhotoCraft 桥接脚本（跑在编辑器页面内部，同一个 realm，避免跨窗口取数据）。
//
// 参数（由 web/photocraft_load_image.js 拼在编辑器 URL 上）：
//   comfy_bridge=1        启用“喂图 / 保存回传”
//   comfy_node=<节点 id>   回传时告诉宿主是哪个节点
//   comfy_input=<文件名>   要自动喂进编辑器的图片（可带子目录）
//   comfy_input_type=input 图片所在的 ComfyUI 目录类型
//
// 另外无论是否带参数，都会在左侧工具栏颜色块下方加一个绿色“快速保存”按钮，
// 等效菜单里的 文件 › 导出 › 快速导出为 PNG。
(() => {
  const TAG = "[comfy_bridge]";
  const log = (...a) => console.log(TAG, ...a);
  const warn = (...a) => console.warn(TAG, ...a);

  const q = new URLSearchParams(location.search);
  const bridgeOn = q.get("comfy_bridge") === "1";
  const nodeId = q.get("comfy_node") || "";
  const inputType = q.get("comfy_input_type") || "input";
  // 上次的编辑快照（分层文档，存在 ComfyUI input 目录里）：有它就直接还原成同一个多图层文档。
  const wantDoc = q.get("comfy_doc") || "";
  // 导出方式：doc = 存分层文档（遮罩节点必须这样，PNG 扁平导出会把图层 alpha 拍平）
  const exportMode = q.get("comfy_export") || "";

  // 要自动喂进编辑器的图片：单图时是 comfy_input，多图合成时是 comfy_inputs（JSON 数组）。
  // 第一张作为文档打开，后面的依次贴成图层。
  function parseInputs() {
    const list = [];
    const multi = q.get("comfy_inputs");
    if (multi) {
      try {
        const parsed = JSON.parse(multi);
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            if (item && item.filename) {
              list.push({
                filename: String(item.filename),
                subfolder: item.subfolder || "",
                type: item.type || inputType,
              });
            }
          }
        }
      } catch (e) {
        warn("bad comfy_inputs", e);
      }
    }
    const single = q.get("comfy_input");
    if (!list.length && single) list.push({ filename: single, subfolder: "", type: inputType });
    return list;
  }
  const wantInputs = parseInputs();
  const wantInput = wantInputs.length === 1 ? wantInputs[0].filename : "";

  const PREFS_KEY = "photocraft.preferences";
  const QUICK_EXPORT_ID = "file.export.quickExportAsPng";
  const DEFAULT_QUICK_EXPORT = "Cmd+Shift+E"; // Cmd 在 Windows/Linux 上就是 Ctrl
  const BTN_POS_KEY = "photocraft.quicksave.position";

  window.__comfyBridge = window.__comfyBridge || { dropped: false, saved: null, error: null };

  // ============================================================ 快速保存按钮
  // 编辑器整个界面画在 canvas 上（egui），没法往里面塞原生控件，所以这里放一个 HTML 浮层按钮，
  // 点击时模拟“快速导出为 PNG”的快捷键，效果与点菜单完全一致。
  function readPrefs() {
    try {
      return JSON.parse(localStorage.getItem(PREFS_KEY) || "{}") || {};
    } catch {
      return {};
    }
  }

  function quickExportShortcut() {
    const prefs = readPrefs();
    const value = prefs?.shortcuts?.[QUICK_EXPORT_ID];
    return typeof value === "string" && value.trim() ? value.trim() : DEFAULT_QUICK_EXPORT;
  }

  /** 把 "Cmd+Shift+E" 这种写法拆成一次键盘事件要的参数。 */
  function parseShortcut(text) {
    const parts = String(text)
      .split("+")
      .map((s) => s.trim())
      .filter(Boolean);
    const mods = { ctrlKey: false, shiftKey: false, altKey: false, metaKey: false };
    let key = null;
    for (const part of parts) {
      const low = part.toLowerCase();
      if (["cmd", "ctrl", "control", "command"].includes(low)) mods.ctrlKey = true;
      else if (low === "shift") mods.shiftKey = true;
      else if (["alt", "option", "opt"].includes(low)) mods.altKey = true;
      else if (["meta", "super", "win"].includes(low)) mods.metaKey = true;
      else key = part;
    }
    if (!key) return null;
    const isLetter = key.length === 1 && /[a-z]/i.test(key);
    const isDigit = key.length === 1 && /[0-9]/.test(key);
    const isFn = /^f\d{1,2}$/i.test(key);
    const code = isLetter
      ? "Key" + key.toUpperCase()
      : isDigit
        ? "Digit" + key
        : isFn
          ? key.toUpperCase()
          : "Key" + key.toUpperCase();
    return { key: isLetter ? key.toLowerCase() : key, code, ...mods };
  }

  function pressShortcut(combo) {
    const targets = [window, document, document.getElementById("photocraft_canvas") || document.body];
    const init = {
      key: combo.key,
      code: combo.code,
      bubbles: true,
      cancelable: true,
      ctrlKey: combo.ctrlKey,
      shiftKey: combo.shiftKey,
      altKey: combo.altKey,
      metaKey: combo.metaKey,
    };
    for (const target of targets) {
      try {
        target.dispatchEvent(new KeyboardEvent("keydown", init));
        target.dispatchEvent(new KeyboardEvent("keyup", init));
      } catch (e) {
        warn("key dispatch failed", e);
      }
    }
    log("pressed", combo.code, JSON.stringify(init));
  }

  function showHint(message) {
    const hint = document.getElementById("comfy_quicksave_hint");
    if (!hint) return;
    hint.textContent = message;
    hint.style.opacity = "1";
    clearTimeout(showHint.timer);
    showHint.timer = setTimeout(() => {
      hint.style.opacity = "0";
    }, 2200);
  }

  function triggerQuickExport() {
    const before = window.__comfyBridge.saved;
    const combo = parseShortcut(quickExportShortcut());
    if (!combo) {
      showHint("没有可用的快捷键，请先打开一个文档");
      return;
    }
    pressShortcut(combo);

    // 1.6 秒内没抓到导出结果，多半是没有打开的文档（快捷键被忽略）。
    setTimeout(() => {
      if (window.__comfyBridge.saved === before) showHint("请先打开或新建一个文档");
    }, 1600);
  }

  function addQuickSaveButton() {
    if (document.getElementById("comfy_quick_save")) return;

    const wrap = document.createElement("div");
    wrap.id = "comfy_quicksave_wrap";
    Object.assign(wrap.style, {
      position: "fixed",
      left: "4px",
      // 默认贴左侧颜色块下方（可拖动，位置会记住）。
      top: "calc(100% - 62px)",
      zIndex: "10",
      display: "flex",
      flexDirection: "column",
      alignItems: "flex-start",
      gap: "4px",
      pointerEvents: "none",
      fontFamily: "system-ui, 'Microsoft YaHei', sans-serif",
    });

    const saved = (() => {
      try {
        return JSON.parse(localStorage.getItem(BTN_POS_KEY) || "null");
      } catch {
        return null;
      }
    })();
    if (saved && typeof saved.left === "number" && typeof saved.top === "number") {
      wrap.style.left = Math.max(0, saved.left) + "px";
      wrap.style.top = Math.max(0, saved.top) + "px";
    }

    const btn = document.createElement("button");
    btn.id = "comfy_quick_save";
    btn.type = "button";
    btn.textContent = "导出";
    btn.title =
      exportMode === "doc"
        ? "保存为分层文档（保留图层 alpha，遮罩节点靠它回传遮罩；可按住拖动位置）"
        : "等效 文件 › 导出 › 快速导出为 PNG（结果保存到 ComfyUI 的 output 目录，不再下载到浏览器）";
    Object.assign(btn.style, {
      pointerEvents: "auto",
      cursor: "pointer",
      padding: "5px 10px",
      fontSize: "12px",
      lineHeight: "16px",
      fontWeight: "600",
      color: "#ffffff",
      background: "#2f9e4f",
      border: "1px solid #26873f",
      borderRadius: "5px",
      boxShadow: "0 1px 3px rgba(0,0,0,0.35)",
      whiteSpace: "nowrap",
      userSelect: "none",
    });
    btn.addEventListener("click", triggerExport);

    const hint = document.createElement("span");
    hint.id = "comfy_quicksave_hint";
    Object.assign(hint.style, {
      pointerEvents: "none",
      fontSize: "11px",
      color: "#d9d9d9",
      background: "rgba(0,0,0,0.7)",
      borderRadius: "4px",
      padding: "2px 6px",
      opacity: "0",
      transition: "opacity 0.25s",
      whiteSpace: "nowrap",
    });

    // 拖动改位置（记住到 localStorage），这样位置不合意时用户自己就能挪。
    let drag = null;
    btn.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      const rect = wrap.getBoundingClientRect();
      drag = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
      e.preventDefault();
    });
    window.addEventListener("mousemove", (e) => {
      if (!drag) return;
      const left = Math.max(0, Math.min(window.innerWidth - 40, e.clientX - drag.dx));
      const top = Math.max(0, Math.min(window.innerHeight - 24, e.clientY - drag.dy));
      wrap.style.left = left + "px";
      wrap.style.top = top + "px";
    });
    window.addEventListener("mouseup", () => {
      if (!drag) return;
      drag = null;
      try {
        localStorage.setItem(
          BTN_POS_KEY,
          JSON.stringify({ left: parseFloat(wrap.style.left), top: parseFloat(wrap.style.top) }),
        );
      } catch {}
    });

    wrap.appendChild(btn);
    wrap.appendChild(hint);
    document.body.appendChild(wrap);
    log("quick save button ready");
  }

  function whenBody(cb) {
    if (document.body) return cb();
    document.addEventListener("DOMContentLoaded", cb, { once: true });
  }

  // ComfyUI 的前端会把节点 web/ 目录下的 JS 递归加载，这个文件因此也会在 ComfyUI 画布上跑一遍。
  // 按钮只属于 PhotoCraft 编辑器页面，靠路径区分，避免在 ComfyUI 里多出一个按钮。
  const isEditorPage = /\/photocraft\/[^/]*\.html$/i.test(location.pathname);
  // 只暴露一个“执行快速导出”的入口，供宿主（ComfyUI 模态框标题栏）调用；同源，直接函数调用即可。
  window.__comfyQuickExport = triggerQuickExport;
  if (isEditorPage) whenBody(addQuickSaveButton);

  // ============================================================ 喂图 + 回传
  if (!bridgeOn) return;

  // 分层文档格式：网页版 File › Save 走的是 services.write → download()，所以 Ctrl+S 也能被这里截到，
  // 截到之后交给宿主缓存起来，下次打开还原成同一个多图层文档。
  const DOC_EXT = /\.(pcraft|psd|psb|ora|kra|xcf|xcfgz|tif|tiff)$/i;

  // 存图回传：PhotoCraft 网页版的保存是 Blob + <a download> + click()（见
  // apps/photocraft-web/src/web.rs 的 download()）。拦在 click 上就能原样拿到导出字节，
  // 并且不再放行浏览器下载（结果统一由 ComfyUI 落到 output 目录）。
  const origClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    const href = this.href;
    const name = this.download;
    if (name && href && href.startsWith("blob:")) {
      const isDoc = DOC_EXT.test(name);
      fetch(href)
        .then((r) => r.blob())
        .then(async (blob) => {
          const bytes = await blob.arrayBuffer();
          if (isDoc) {
            window.__comfyBridge.doc = { name, type: blob.type, size: bytes.byteLength };
          } else {
            window.__comfyBridge.saved = { name, type: blob.type, size: bytes.byteLength };
          }
          log(isDoc ? "captured document:" : "captured save:", name, blob.type, bytes.byteLength, "bytes");
          try {
            // 弹窗打开时是 window.opener；嵌在 ComfyUI 的模态框 iframe 里时是 window.parent。
            const host =
              window.opener && !window.opener.closed
                ? window.opener
                : window.parent && window.parent !== window
                  ? window.parent
                  : null;
            if (host) {
              host.postMessage({ type: isDoc ? "photocraft_doc" : "photocraft_saved", nodeId, name, mime: blob.type, bytes }, "*");
              log("posted to host window, node =", nodeId, isDoc ? "(document snapshot)" : "(image)");
              showHint(isDoc ? "已保存分层文档到 ComfyUI" : "已导出，保存到 ComfyUI 的 output 目录");
            } else {
              warn("no host window to post to");
            }
          } catch (e) {
            warn("postMessage failed", e);
          }
        })
        .catch((e) => warn("could not read the saved blob", e));

      // 一律不放行浏览器下载：导出/保存的字节已经走 postMessage 交给 ComfyUI，
      // 由宿主写进 ComfyUI 的 output 目录，不再往浏览器的下载目录塞文件。
      return;
    }
    return origClick.apply(this, arguments);
  };
  log("save hook installed");

  /** 让编辑器把当前文档存成分层快照（默认快捷键 Cmd+S = File › Save），字节由上面的钩子截走。 */
  function requestDocSnapshot() {
    const prefs = readPrefs();
    const combo = parseShortcut(prefs?.shortcuts?.["file.save"] || "Cmd+S");
    if (!combo) return false;
    pressShortcut(combo);
    log("asked the editor for a document snapshot");
    return true;
  }

  // 供宿主（ComfyUI 页面）在关闭弹窗、导出完成时调用，同源直接函数调用。
  window.__comfyDocSnapshot = requestDocSnapshot;

  /** 导出按钮：遮罩节点存分层文档（保住图层 alpha），其它节点还是快速导出 PNG。 */
  function triggerExport() {
    if (exportMode === "doc") {
      if (!requestDocSnapshot()) showHint("没有可用的快捷键，请先打开一个文档");
      else showHint("正在保存分层文档…");
      return;
    }
    triggerQuickExport();
  }
  window.__comfyExport = triggerExport;

  // 自动喂图：PhotoCraft 网页外壳读的是 egui 的 dropped_files（浏览器不能同步读文件，它异步读）。
  // 造一个带 File 的 DataTransfer，在画布上抛 dragover + drop 即可。
  // 落点决定结果：顶部菜单区（clientY≈8）→ 作为文档打开；文档画布中部 → 贴成图层。
  function dispatchDrop(file, placeLayer) {
    const dt = new DataTransfer();
    dt.items.add(file);
    const target = document.getElementById("photocraft_canvas") || document.body;
    const rect = target.getBoundingClientRect();
    const init = {
      bubbles: true,
      cancelable: true,
      composed: true,
      dataTransfer: dt,
      clientX: placeLayer ? rect.left + rect.width / 2 : 8,
      clientY: placeLayer ? rect.top + rect.height / 2 : 8,
    };
    target.dispatchEvent(new DragEvent("dragover", init));
    target.dispatchEvent(new DragEvent("drop", init));
  }

  async function fetchImageBlob(meta) {
    const name = String(meta.filename || "").split("/").pop();
    const subfolder =
      meta.subfolder || (meta.filename && meta.filename.includes("/") ? meta.filename.slice(0, meta.filename.lastIndexOf("/")) : "");
    const url = `/view?filename=${encodeURIComponent(name)}&type=${encodeURIComponent(
      meta.type || inputType,
    )}&subfolder=${encodeURIComponent(subfolder)}`;
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) {
        window.__comfyBridge.error = `input fetch ${res.status}`;
        warn("input fetch failed:", res.status, url);
        return null;
      }
      return { name, blob: await res.blob() };
    } catch (e) {
      window.__comfyBridge.error = String(e);
      warn("input fetch error", e);
      return null;
    }
  }

  /** 打开上次的编辑快照：分层文档直接当文档导入，图层、蒙版、混合模式都在。 */
  async function loadDoc() {
    const got = await fetchImageBlob({ filename: wantDoc, type: inputType });
    if (!got) {
      warn("could not fetch the cached document, falling back to the node's images");
      return false;
    }
    const type = got.blob.type || "application/octet-stream";
    const file = new File([got.blob], got.name, { type });
    dispatchDrop(file, false);
    window.__comfyBridge.dropped = true;
    window.__comfyBridge.restored = got.name;
    log("restored document:", got.name, got.blob.size, "bytes");
    return true;
  }

  async function loadInputs() {
    if (wantDoc) {
      const restored = await loadDoc();
      if (restored) {
        window.__comfyBridge.layers = 0;
        return;
      }
    }

    let placed = 0;
    for (const [index, meta] of wantInputs.entries()) {
      const got = await fetchImageBlob(meta);
      if (!got) continue;
      const type = got.blob.type && got.blob.type.startsWith("image/") ? got.blob.type : "image/png";
      const file = new File([got.blob], got.name, { type });
      dispatchDrop(file, index > 0);
      placed += 1;
      log(index === 0 ? "dropped input as document:" : "dropped input as layer:", got.name, got.blob.size, "bytes");
      // 等应用把上一张处理完再喂下一张，否则图层落点还没建立文档。
      await new Promise((resolve) => setTimeout(resolve, index === 0 ? 1500 : 1000));
    }
    window.__comfyBridge.dropped = placed > 0;
    window.__comfyBridge.layers = placed;
  }

  // 应用跑起来的可靠信号：#photocraft_loading 由 Rust 在启动后自己移除。
  function whenReady(cb) {
    let tries = 0;
    const tick = () => {
      tries += 1;
      if (!document.getElementById("photocraft_loading")) return cb();
      if (tries > 200) {
        warn("app not ready after 20s, dropping anyway");
        return cb();
      }
      setTimeout(tick, 100);
    };
    setTimeout(tick, 200);
  }

  if (wantDoc || wantInputs.length) whenReady(() => setTimeout(loadInputs, 300));
})();
