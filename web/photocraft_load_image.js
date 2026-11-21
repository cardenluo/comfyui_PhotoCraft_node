import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";

const LOAD_NODE = "photoCraft_load_image";
const COMBINE_NODE = "photoCraft_image_combine";
const CROP_STITCH_NODE = "photoCraft_crop_stitch";
const MASK_NODE = "photoCraft_mask";
const MAX_COMBINE_INPUTS = 32;

// PhotoCraft 网页版把界面偏好存在这个 localStorage 键里（见 apps/photocraft-web/src/web.rs 的 PREFS_KEY）。
const PREFS_KEY = "photocraft.preferences";
const DEFAULT_LANGUAGE = "zh-hans";

const MODAL_ID = "photocraft_modal";

/**
 * 网页构建把 interface.language 的 auto 固定回退成英文，所以这里在第一次打开编辑器之前，
 * 把缺省的 interface.language 补成简体中文。已有用户选择时不动，改回英文也不会被覆盖。
 * localStorage 与编辑器同源（都是 ComfyUI 这个 origin），所以宿主这边写入对编辑器生效。
 */
function ensureChineseDefault() {
    try {
        const raw = localStorage.getItem(PREFS_KEY);
        let prefs = {};
        if (raw) {
            try {
                prefs = JSON.parse(raw) || {};
            } catch {
                prefs = {};
            }
        }
        if (typeof prefs !== "object" || Array.isArray(prefs) || prefs === null) prefs = {};
        if (typeof prefs.interface !== "object" || prefs.interface === null || Array.isArray(prefs.interface)) {
            prefs.interface = {};
        }
        // "auto" 也要覆盖：网页构建里 auto 实际固定回退成英文（浏览器语言探测还没实现）。
        if (!prefs.interface.language || prefs.interface.language === "auto") {
            prefs.interface.language = DEFAULT_LANGUAGE;
            localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
            console.log("[PhotoCraft] 已把界面默认语言设为简体中文");
        }
    } catch (e) {
        console.warn("[PhotoCraft] 无法写入默认语言偏好", e);
    }
}

function currentImage(node) {
    const widget = node.widgets?.find((w) => w.name === "image");
    return typeof widget?.value === "string" ? widget.value : "";
}

/**
 * inputs 为空时按 Load Image 的方式喂单图（读节点上的 image 控件）；
 * 传了 inputs（多图合成）时，把这些图按顺序交给编辑器，第一张开文档、其余贴图层。
 */
function editorUrl(node, inputs, doc) {
    const url = new URL("./photocraft/index.html", import.meta.url);
    // 每次打开都带一个时间戳，避免浏览器用缓存的旧 index.html（语言默认那段就写在里面）。
    url.searchParams.set("_t", String(Date.now()));
    url.searchParams.set("comfy_bridge", "1");
    url.searchParams.set("comfy_node", String(node.id));
    url.searchParams.set("comfy_input_type", "input");
    // 遮罩节点导出的必须是分层文档：PNG 扁平导出会把上层 alpha 拍平，遮罩就丢了
    if (node.type === MASK_NODE) url.searchParams.set("comfy_export", "doc");
    if (doc?.filename) {
        // 有上次的编辑快照就优先还原它（分层文档）。
        url.searchParams.set("comfy_doc", doc.filename);
    } else if (inputs?.length) {
        url.searchParams.set("comfy_inputs", JSON.stringify(inputs));
    } else {
        const image = currentImage(node);
        if (image) url.searchParams.set("comfy_input", image);
    }
    return url;
}

// ------------------------------------------------- 上次编辑状态（分层文档快照）

/** 快照存在 ComfyUI input 目录里，节点属性只记文件名（会跟着工作流一起保存）。 */
function cachedDoc(node) {
    const name = node.properties?.photocraft_doc;
    return typeof name === "string" && name ? name : "";
}

/** 端口上的图片变了，上次的快照就过期了：这时按端口重新组图层，而不是还原旧文档。 */
function inputsFingerprint(inputs) {
    return JSON.stringify((inputs || []).map((item) => `${item.type || "input"}/${item.subfolder || ""}/${item.filename}`));
}

function snapshotStillMatches(node, fingerprint) {
    const saved = node.properties?.photocraft_inputs;
    if (typeof saved !== "string" || !saved || !fingerprint) return true;
    return saved === fingerprint;
}

async function resolveCachedDoc(node, fingerprint) {
    const name = cachedDoc(node);
    if (!name) return null;
    if (!snapshotStillMatches(node, fingerprint)) {
        console.log("[PhotoCraft] 输入的图片变了，忽略上次的编辑快照");
        node.properties.photocraft_doc = "";
        return null;
    }
    try {
        const url = api.apiURL(`/view?filename=${encodeURIComponent(name)}&type=input&subfolder=`);
        const response = await fetch(url, { method: "HEAD" });
        if (response.ok) return { filename: name, type: "input" };
    } catch {}
    // 文件没了就别再用它，免得编辑器里空转
    node.properties.photocraft_doc = "";
    return null;
}

/** 让编辑器把当前文档存成分层快照，宿主这边接住字节并缓存。 */
function requestDocSnapshot(win) {
    try {
        return Boolean(win?.__comfyDocSnapshot?.());
    } catch {
        return false;
    }
}

// --------------------------------------------------- 多图端口的图片来源解析

const IMAGE_EXT = /\.(png|jpe?g|webp|bmp|tiff?|gif)$/i;

/**
 * 拆解 LoadImage 那种“带标注”的值：ComfyUI 允许把类型标在名字尾部，
 * 形如 `sub/folder/name.png [input]`（folder_paths.get_annotated_filepath 的格式）。
 * 这些标注不能当文件名传给服务端，否则会 404。
 */
function splitAnnotated(value) {
    let text = String(value ?? "").trim();
    const marker = text.match(/\s*\[(input|output|temp)\]\s*$/i);
    if (marker) text = text.slice(0, marker.index);
    const cut = text.lastIndexOf("/");
    return {
        filename: cut >= 0 ? text.slice(cut + 1) : text,
        subfolder: cut >= 0 ? text.slice(0, cut) : "",
        type: marker ? marker[1].toLowerCase() : "input",
    };
}

/** 从一个节点的输出里找出实际可取的图片文件（优先 image 控件，其次已执行节点的预览输出，再往上追）。 */
function describeSource(node, depth = 0) {
    if (!node || depth > 6) return null;

    const widget = node.widgets?.find?.((w) => w.name === "image");
    if (typeof widget?.value === "string" && IMAGE_EXT.test(widget.value)) {
        return splitAnnotated(widget.value);
    }

    const out = app.nodeOutputs?.[node.id]?.images?.[0];
    if (out?.filename) {
        return { filename: out.filename, subfolder: out.subfolder || "", type: out.type || "temp" };
    }

    for (const input of node.inputs || []) {
        if (input?.link == null) continue;
        const link = app.graph.links?.[input.link] ?? app.graph.links?.get?.(input.link);
        if (!link) continue;
        const origin = app.graph.getNodeById(link.origin_id);
        const found = describeSource(origin, depth + 1);
        if (found) return found;
    }
    return null;
}

/** 按 image1、image2… 的顺序收集已连接端口上的图片来源。 */
function collectCombineInputs(node) {
    const entries = [];
    const slots = (node.inputs || []).filter((i) => /^image\d+$/.test(i.name || ""));
    slots.sort((a, b) => Number(a.name.slice(5)) - Number(b.name.slice(5)));
    for (const slot of slots) {
        if (slot.link == null) continue;
        const link = app.graph.links?.[slot.link] ?? app.graph.links?.get?.(slot.link);
        if (!link) continue;
        const origin = app.graph.getNodeById(link.origin_id);
        const found = describeSource(origin);
        if (found) entries.push(found);
    }
    return entries;
}

// ==================================================================== 模态框

const MODAL_CSS = `
#${MODAL_ID} {
  position: fixed; inset: 0; z-index: 9000;
  display: flex; align-items: center; justify-content: center;
  background: rgba(0, 0, 0, 0.62);
  backdrop-filter: blur(2px);
  font-family: system-ui, "Microsoft YaHei", sans-serif;
  animation: pcFade .16s ease-out;
}
@keyframes pcFade { from { opacity: 0 } to { opacity: 1 } }
#${MODAL_ID}_panel {
  display: flex; flex-direction: column;
  width: min(1600px, 94vw); height: 92vh;
  background: #202024;
  border: 1px solid #43434b;
  border-radius: 12px;
  box-shadow: 0 26px 70px rgba(0, 0, 0, 0.6);
  overflow: hidden;
}
#${MODAL_ID}_bar {
  display: flex; align-items: center; gap: 10px;
  height: 38px; padding: 0 10px 0 14px; flex: none;
  background: linear-gradient(#2c2c32, #232328);
  border-bottom: 1px solid #3a3a41;
  cursor: move; user-select: none;
}
#${MODAL_ID}_dot { width: 9px; height: 9px; border-radius: 50%; background: #2f9e4f; box-shadow: 0 0 8px rgba(47,158,79,.7); flex: none; }
#${MODAL_ID}_title { color: #e8e8ea; font-size: 13px; font-weight: 600; letter-spacing: .2px; }
#${MODAL_ID}_sub { color: #8b8b93; font-size: 11px; margin-left: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#${MODAL_ID}_actions { margin-left: auto; display: flex; align-items: center; gap: 4px; flex: none; }
#${MODAL_ID}_max {
  width: 26px; height: 22px; border: 0; border-radius: 5px;
  background: transparent; color: #b9b9c0; font-size: 13px; line-height: 20px;
  cursor: pointer; flex: none;
}
#${MODAL_ID}_max:hover { background: #3a3a44; color: #fff; }
#${MODAL_ID}_close {
  width: 26px; height: 22px; border: 0; border-radius: 5px;
  background: transparent; color: #b9b9c0; font-size: 15px; line-height: 20px;
  cursor: pointer; flex: none;
}
#${MODAL_ID}_close:hover { background: #d9534f; color: #fff; }
#${MODAL_ID}_frame { flex: 1 1 auto; width: 100%; border: 0; background: #262626; }
`;

function injectModalCss() {
    if (document.getElementById(`${MODAL_ID}_css`)) return;
    const style = document.createElement("style");
    style.id = `${MODAL_ID}_css`;
    style.textContent = MODAL_CSS;
    document.head.appendChild(style);
}

function closePhotoCraftModal() {
    const overlay = document.getElementById(MODAL_ID);
    if (pendingCloseTimer) {
        clearTimeout(pendingCloseTimer);
        pendingCloseTimer = null;
    }
    requestClosePhotoCraftModal.pending = false;
    if (!overlay) return;
    overlay.remove();
    document.removeEventListener("keydown", onModalKey, true);
}

/** 关弹窗前的等待计时器：快照消息到了就提前收尾，没到就靠它兜底。 */
let pendingCloseTimer = null;

/** 快照已经存好（或超时）：真正拆弹窗。 */
function finishPendingClose() {
    if (!requestClosePhotoCraftModal.pending) return;
    if (pendingCloseTimer) {
        clearTimeout(pendingCloseTimer);
        pendingCloseTimer = null;
    }
    requestClosePhotoCraftModal.pending = false;
    const overlay = document.getElementById(MODAL_ID);
    if (!overlay) return;
    overlay.remove();
    document.removeEventListener("keydown", onModalKey, true);
}

/**
 * 关闭前先把当前文档存成分层快照（编辑器内存里才有图层，关掉就没了）。
 * 不等固定时长：photocraft_doc 消息一到就关（通常几百毫秒），只有迟迟等不到才按 3 秒兜底。
 */
function requestClosePhotoCraftModal() {
    if (requestClosePhotoCraftModal.pending) return;
    const overlay = document.getElementById(MODAL_ID);
    if (!overlay) return;

    const frame = document.getElementById(`${MODAL_ID}_frame`);
    const started = requestDocSnapshot(frame?.contentWindow);
    if (!started) {
        closePhotoCraftModal();
        return;
    }

    requestClosePhotoCraftModal.pending = true;
    const sub = document.getElementById(`${MODAL_ID}_sub`);
    if (sub) sub.textContent = "正在缓存编辑状态…";
    pendingCloseTimer = setTimeout(finishPendingClose, 3000);
}

function onModalKey(event) {
    if (event.key === "Escape") {
        event.stopPropagation();
        requestClosePhotoCraftModal();
    }
}

/** 在 ComfyUI 页面内以模态框打开编辑器：圆角面板 + 自绘标题栏，不再另开浏览器窗口。 */
function showPhotoCraftModal(url, title, node) {
    injectModalCss();
    closePhotoCraftModal();

    const overlay = document.createElement("div");
    overlay.id = MODAL_ID;

    const panel = document.createElement("div");
    panel.id = `${MODAL_ID}_panel`;

    const bar = document.createElement("div");
    bar.id = `${MODAL_ID}_bar`;

    const dot = document.createElement("div");
    dot.id = `${MODAL_ID}_dot`;

    const heading = document.createElement("div");
    heading.id = `${MODAL_ID}_title`;
    heading.textContent = "PhotoCraft";

    const sub = document.createElement("div");
    sub.id = `${MODAL_ID}_sub`;
    sub.textContent = title || "";

    const close = document.createElement("button");
    close.id = `${MODAL_ID}_close`;
    close.type = "button";
    close.title = "关闭（Esc）";
    close.textContent = "✕";
    close.addEventListener("click", requestClosePhotoCraftModal);

    const maximize = document.createElement("button");
    maximize.id = `${MODAL_ID}_max`;
    maximize.type = "button";
    maximize.title = "最大化 / 还原";
    maximize.textContent = "⤢";

    const actions = document.createElement("div");
    actions.id = `${MODAL_ID}_actions`;
    actions.append(maximize, close);

    const frame = document.createElement("iframe");
    frame.id = `${MODAL_ID}_frame`;
    frame.src = url.href;
    frame.allow = "clipboard-read; clipboard-write";

    bar.append(dot, heading, sub, actions);
    panel.append(bar, frame);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    // ---- 窗口状态：最大化 / 拖动后的位置
    const win = { maximized: false, pos: null };

    function applyLayout() {
        if (win.maximized) {
            Object.assign(panel.style, {
                position: "fixed",
                left: "0px",
                top: "0px",
                width: "100vw",
                height: "100vh",
                borderRadius: "0",
                margin: "0",
            });
        } else if (win.pos) {
            Object.assign(panel.style, {
                position: "fixed",
                left: win.pos.left + "px",
                top: win.pos.top + "px",
                width: "",
                height: "",
                borderRadius: "",
            });
        } else {
            Object.assign(panel.style, { position: "", left: "", top: "", width: "", height: "", borderRadius: "" });
        }
        overlay.style.padding = win.maximized ? "0" : "";
    }

    maximize.addEventListener("click", () => {
        win.maximized = !win.maximized;
        maximize.textContent = win.maximized ? "❐" : "⤢";
        applyLayout();
    });

    // 点面板外空白处关闭：和 ✕ 走同一条路径（先存快照再拆，快照到了立即关）
    overlay.addEventListener("mousedown", (event) => {
        if (event.target === overlay) requestClosePhotoCraftModal();
    });
    document.addEventListener("keydown", onModalKey, true);

    // 拖动标题栏移动面板（最大化时禁用）
    let drag = null;
    bar.addEventListener("mousedown", (event) => {
        if (event.target === close || event.target === maximize) return;
        if (win.maximized) return;
        const rect = panel.getBoundingClientRect();
        drag = { dx: event.clientX - rect.left, dy: event.clientY - rect.top };
        win.pos = { left: rect.left, top: rect.top };
        applyLayout();
        event.preventDefault();
    });
    window.addEventListener("mousemove", (event) => {
        if (!drag) return;
        win.pos = {
            left: Math.max(0, Math.min(window.innerWidth - 80, event.clientX - drag.dx)),
            top: Math.max(0, Math.min(window.innerHeight - 40, event.clientY - drag.dy)),
        };
        applyLayout();
    });
    window.addEventListener("mouseup", () => {
        drag = null;
    });

    return overlay;
}

async function openPhotoCraft(node, inputs, subtitle, doc) {
    ensureChineseDefault();

    const url = editorUrl(node, inputs, doc);

    let response;
    try {
        response = await fetch(url, { method: "HEAD" });
    } catch (e) {
        alert(`无法访问 PhotoCraft 网页：${e.message || e}`);
        return;
    }
    if (!response.ok) {
        alert(
            "PhotoCraft 网页尚未构建。请确认 web/photocraft/index.html 存在（或运行 build_photocraft_web.ps1），然后重启 ComfyUI。",
        );
        return;
    }

    showPhotoCraftModal(url, subtitle ?? currentImage(node), node);
}

/** 多图合成节点：把已连接端口上的图交给编辑器，打开就是多图层文档。 */
async function openPhotoCraftCombine(node) {
    // 上游文件原样交付：3 通道就是 3 通道，带 alpha 的 RGBA 就带着 alpha 进去，
    // 不抹平、不把遮罩并进图里（之前按"看起来干净"抹平 alpha，等于替用户改了上游数据）。
    const inputs = collectCombineInputs(node);
    rememberSources(node, inputs);
    const fingerprint = JSON.stringify({ v: 5, inputs });

    // 有上次的编辑快照、且端口没换图，就先还原那个文档；否则按端口重新组图层。
    const doc = await resolveCachedDoc(node, fingerprint);
    if (doc) {
        await openPhotoCraft(node, null, `恢复上次编辑（${doc.filename}）`, doc);
        return;
    }

    if (!inputs.length) {
        alert("请先把要合成的图片接到 image1、image2 … 端口，再打开编辑器。");
        return;
    }
    node.properties = node.properties || {};
    node.properties.photocraft_inputs = fingerprint;
    node.properties.photocraft_doc = "";
    await openPhotoCraft(node, inputs, `多图层（${inputs.length} 张）`);
}

// ==================================================== 多图合成节点的动态端口

function combineSlots(node) {
    return (node.inputs || []).filter((input) => /^image\d+$/.test(input?.name || ""));
}

function lastConnectedSlot(node) {
    let last = 0;
    for (const slot of combineSlots(node)) {
        const index = Number(slot.name.slice(5));
        if (slot.link != null && index > last) last = index;
    }
    return last;
}

/** 保持“最后一个已连接端口后面永远有一个空端口”：接上一张就自动长出下一个。 */
function syncCombineInputs(node) {
    if (!node) return;
    const want = Math.min(MAX_COMBINE_INPUTS, Math.max(1, lastConnectedSlot(node) + 1));
    const have = combineSlots(node).length;

    for (let index = have + 1; index <= want; index += 1) {
        node.addInput(`image${index}`, "IMAGE");
    }

    if (have > want) {
        for (let index = have; index > want; index -= 1) {
            const slotIndex = (node.inputs || []).findIndex((input) => input?.name === `image${index}`);
            if (slotIndex >= 0) node.removeInput(slotIndex);
        }
    }

    node.setSize?.(node.computeSize?.() ?? undefined);
    app.graph.setDirtyCanvas(true, true);
}

// ========================================== 输入端口自动串「Preview Image」

/**
 * 节点的图片输入自动串一个「Preview Image」：上游 → Preview Image → 节点输入。
 * 合成节点用在 image1…imageN 上，裁切回贴节点用在 inpainted_image 上。
 * 这样每根输入都有可见的预览，进入节点的是预览过的那一份。
 */
const PREVIEW_CHAIN_TYPE = "PreviewImage";
let chainingPreview = false;

function isPreviewChainNode(node) {
    return String(node?.type || "") === PREVIEW_CHAIN_TYPE;
}

function isCombineSlotName(name) {
    return /^image\d+$/.test(String(name || ""));
}

function isCropStitchSlotName(name) {
    return String(name || "") === "inpainted_image";
}

/** 把 node 的第 slotIndex 个输入改接成「上游 → Preview Image → node」。 */
function chainPreviewBefore(node, slotIndex) {
    if (chainingPreview) return;
    const input = (node.inputs || [])[slotIndex];
    const name = String(input?.name || "");
    if (!input || input.link == null) return;
    if (!isCombineSlotName(name) && !isCropStitchSlotName(name)) return;

    const link = app.graph.links?.[input.link] ?? app.graph.links?.get?.(input.link);
    if (!link) return;
    const origin = app.graph.getNodeById(link.origin_id);
    if (!origin || origin === node || isPreviewChainNode(origin)) return;

    const preview = LiteGraph.createNode(PREVIEW_CHAIN_TYPE);
    if (!preview) {
        console.warn("[PhotoCraft] 没找到 Preview Image 节点，无法自动串预览");
        return;
    }
    chainingPreview = true;
    try {
        app.graph.add(preview);
        preview.pos = [node.pos[0] - 240, node.pos[1] + slotIndex * 26];
        node.disconnectInput(slotIndex);
        const first = origin.connect(link.origin_slot, preview, 0);
        const second = preview.connect(0, node, slotIndex);
        if (!first || !second) {
            console.warn("[PhotoCraft] 自动串预览失败，恢复原连线");
            preview.disconnectInput?.(0);
            node.disconnectInput(slotIndex);
            origin.connect(link.origin_slot, node, slotIndex);
        } else {
            console.log("[PhotoCraft] 已在 " + name + " 前串入 Preview Image");
        }
    } finally {
        chainingPreview = false;
    }
    app.graph.setDirtyCanvas(true, true);
}

/** 工作流里已经直连的输入，加载后补串一次预览节点（节点可能还没配好，多等两轮）。 */
function chainAllPreviews(node) {
    const pass = (attempt) => {
        let pending = false;
        (node.inputs || []).forEach((input, index) => {
            const name = String(input?.name || "");
            if (!isCombineSlotName(name) && !isCropStitchSlotName(name)) return;
            if (input.link == null) return;
            const link = app.graph.links?.[input.link] ?? app.graph.links?.get?.(input.link);
            const origin = link ? app.graph.getNodeById(link.origin_id) : null;
            if (!origin) {
                pending = true;
                return;
            }
            if (!isPreviewChainNode(origin)) {
                chainPreviewBefore(node, index);
                pending = true;
            }
        });
        if (node.type === COMBINE_NODE) syncCombineInputs(node);
        if (pending && attempt < 3) setTimeout(() => pass(attempt + 1), 300);
    };
    setTimeout(() => pass(0), 0);
}

// ============================================================== 保存结果回传

function extensionFor(mime) {
    if (mime === "image/jpeg") return ".jpg";
    if (mime === "image/webp") return ".webp";
    return ".png";
}

/** 回传的文件名不沿用编辑器里的原名：避免和原始输入同名互相覆盖，也保证是可读的图片扩展名。 */
function uploadName(preferred, mime) {
    const base = (preferred || "photocraft")
        .replace(/\.[a-z0-9]+$/i, "")
        .replace(/[\\/:*?"<>|]+/g, "_")
        .slice(0, 60) || "photocraft";
    return `${base}_edit_${Date.now()}${extensionFor(mime)}`;
}

/** 上传到 ComfyUI 的指定目录：output = 结果归档（用户可见），input = 节点引用用的工作副本。 */
async function uploadToComfy(bytes, name, mime, type = "input") {
    const blob = new Blob([bytes], { type: mime || "image/png" });
    const body = new FormData();
    body.append("image", new File([blob], name, { type: mime || "image/png" }));
    body.append("type", type);
    body.append("overwrite", "true");

    const response = await api.fetchApi("/upload/image", { method: "POST", body });
    if (!response.ok) throw new Error(`上传到 ${type} 失败：HTTP ${response.status}`);
    const info = await response.json();
    return { ...info, type: info.type || type };
}

function uploadToInput(bytes, name, mime) {
    return uploadToComfy(bytes, name, mime, "input");
}

/** 记下这次打开编辑器用的图片来源：导出时用它们给透明区垫底（编辑器可能还原缓存文档，所以每次打开都记）。 */
function rememberSources(node, sources) {
    const list = (sources || []).filter((item) => item && item.filename);
    if (!node || !list.length) return;
    node.properties = node.properties || {};
    node.properties.photocraft_sources = list.map((item) => ({
        filename: item.filename,
        subfolder: item.subfolder || "",
        type: item.type || "input",
    }));
}

/** 导出时是否保留原始 alpha：只有通道模式选了 keep_alpha 才原样归档 RGBA。 */
function wantsRawAlpha(node) {
    const widget = node.widgets?.find((w) => w.name === "alpha_mode");
    return (widget?.value || "drop_alpha") === "keep_alpha";
}

/**
 * 把编辑器导出的 RGBA 合成成不透明 PNG：output 归档 + input 工作副本各一份。
 * 必要性：PhotoCraft 的 PNG 导出会把画布透明区压成黑色 RGB，直接当 IMAGE 用就是一块黑斑，
 * 看着就像遮罩被并进了图片。服务端用上游原图垫底、再按 alpha 叠上导出结果，
 * 透明区还原成上游本来那块像素，整张图 alpha=255，下游任何节点都不会再看到"洞"。
 */
async function makeOpaqueExport(node, staging, name) {
    const sources = node.properties?.photocraft_sources || [];
    const response = await api.fetchApi("/photocraft/opaque", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ staging: staging.name, out: name, sources }),
    });
    if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(`HTTP ${response.status}${detail ? `：${detail}` : ""}`);
    }
    const info = await response.json();
    return { name: info.name, subfolder: info.subfolder || "", type: "input" };
}

/** 把上传结果写回节点：结果控件值、下拉候选，以及节点上的预览图。 */
function applyImageToNode(node, info, widgetName = "image") {
    const filename = info.subfolder ? `${info.subfolder}/${info.name}` : info.name;
    const widget = node.widgets?.find((w) => w.name === widgetName);
    if (widget) {
        const values = widget.options?.values;
        if (Array.isArray(values) && !values.includes(filename)) values.push(filename);
        widget.value = filename;
        try {
            widget.callback?.(filename);
        } catch {}
    }

    setNodePreview(node, info);
}

/** 只刷新节点上的缩略图预览，不动任何控件值。 */
function setNodePreview(node, info) {
    const viewUrl = api.apiURL(
        `/view?filename=${encodeURIComponent(info.name)}&type=${encodeURIComponent(
            info.type || "input",
        )}&subfolder=${encodeURIComponent(info.subfolder || "")}&rand=${Date.now()}`,
    );
    const img = new Image();
    img.onload = () => {
        node.imgs = [img];
        node.imageIndex = 0;
        node.setSizeForImage?.(true);
        app.graph.setDirtyCanvas(true, true);
    };
    img.src = viewUrl;

    node.imgs = [img];
    node.imageIndex = 0;
    node.setSizeForImage?.(true);
    app.graph.setDirtyCanvas(true, true);
}

/**
 * 导出后直接把图推给下游的预览节点：不用再跑一次队列，预览框立刻就是新图。
 * 只处理「直接连在线后、本身只做显示」的节点（PreviewImage 这一类）；要参与计算的节点
 * 没法凭空算出结果，仍然需要正常执行。
 */
const PREVIEW_TYPE_RE = /preview|showimage/i;

function pushPreviewToDownstream(node, info, maskInfo = null) {
    const imageInfo = {
        filename: info.name,
        subfolder: info.subfolder || "",
        type: info.type || "input",
    };
    for (const out of node.outputs || []) {
        if (!out) continue;
        const isMask = String(out.name || "").toLowerCase() === "mask";
        if (isMask && !maskInfo) continue; // 没有遮罩灰度图就不推
        const payload = isMask
            ? { name: maskInfo.name, subfolder: maskInfo.subfolder || "", type: maskInfo.type || "temp" }
            : info;
        for (const linkId of out.links || []) {
            const link = app.graph.links?.[linkId] ?? app.graph.links?.get?.(linkId);
            if (!link) continue;
            const target = app.graph.getNodeById(link.target_id);
            if (!target || !PREVIEW_TYPE_RE.test(String(target.type || ""))) continue;
            setNodePreview(target, payload);
            const shown = {
                filename: payload.name,
                subfolder: payload.subfolder || "",
                type: payload.type || "temp",
            };
            target.images = [shown];
            if (app.nodeOutputs) app.nodeOutputs[target.id] = { images: [shown] };
            app.graph.setDirtyCanvas(true, true);
            console.log("[PhotoCraft] 已推送到下游预览节点", target.id, target.type, isMask ? "MASK" : "IMAGE");
        }
    }
}

/** 遮罩结果存在分层文档里，浏览器渲不出来：让服务端把遮罩摊成灰度图再当预览。 */
async function requestMaskPreview(node, info, invert = false) {
    try {
        const response = await api.fetchApi("/photocraft/maskpreview", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                filename: info.name,
                subfolder: info.subfolder || "",
                type: info.type || "input",
                invert: Boolean(invert),
                out: `photocraft_maskprev_${node.id}.png`,
            }),
        });
        if (!response.ok) {
            console.warn("[PhotoCraft] 遮罩预览生成失败", response.status);
            return null;
        }
        return await response.json();
    } catch (e) {
        console.warn("[PhotoCraft] 遮罩预览请求异常", e);
        return null;
    }
}

function findNode(id) {
    const numeric = Number(id);
    return (
        (Number.isFinite(numeric) ? app.graph.getNodeById(numeric) : null) ||
        app.graph.getNodeById(id) ||
        null
    );
}

// 编辑器导出后由 comfy_bridge.js 发回来（弹窗时来自 opener，模态框时来自 iframe 的 parent）：
// 上传成 input 图片并写回对应节点。
window.addEventListener("message", async (event) => {
    const data = event.data;
    if (!data || (data.type !== "photocraft_saved" && data.type !== "photocraft_doc")) return;

    const node = findNode(data.nodeId);
    if (!node) {
        console.warn("[PhotoCraft] 回传找不到节点", data.nodeId);
        return;
    }

    // 分层文档快照：缓存到 input 目录，节点属性里只记文件名，下次打开直接还原这个文档。
    if (data.type === "photocraft_doc") {
        // 字节已经到宿主手里了：正在等关闭的话，先把弹窗拆掉（视图上立刻响应），
        // 上传/缓存放到后台继续，不让大 PSD 的上传时间拖住关窗。
        finishPendingClose();
        try {
            const bytes = new Uint8Array(data.bytes);
            const ext = (String(data.name).match(/\.[a-z0-9]+$/i) || [".psd"])[0].toLowerCase();
            const info = await uploadToInput(bytes, `photocraft_doc_${node.id}${ext}`, data.mime);
            node.properties = node.properties || {};
            node.properties.photocraft_doc = info.subfolder ? `${info.subfolder}/${info.name}` : info.name;
            if (node.type === MASK_NODE) {
                // 遮罩节点的结果就是这个分层文档（PNG 扁平导出会把 alpha 拍平，遮罩就丢了）
                const widget = node.widgets?.find((w) => w.name === "mask_out");
                if (widget) widget.value = info.subfolder ? `${info.subfolder}/${info.name}` : info.name;
                // 节点上的缩略图：浏览器渲不了 PSD，让服务端把遮罩摊成灰度图再显示
                const preview = await requestMaskPreview(node, info);
                if (preview?.name) setNodePreview(node, preview);
            }
            app.graph.setDirtyCanvas(true, true);
            console.log("[PhotoCraft] 已缓存编辑状态", node.id, node.properties.photocraft_doc, bytes.byteLength, "bytes");
        } catch (e) {
            console.warn("[PhotoCraft] 缓存编辑状态失败", e);
        }
        return;
    }

    try {
        const bytes = new Uint8Array(data.bytes);
        const name = uploadName(data.name, data.mime);
        const background = backgroundOf(node);

        // 原始导出原样保留两份：input 是节点引用（带 alpha，MASK 就从这份的 alpha 算），
        // output 是归档。要不要垫底色由节点上的 background 控件决定，前端不再擅自抹 alpha。
        const info = await uploadToInput(bytes, name, data.mime);
        const outInfo = await uploadToComfy(bytes, name, data.mime, "output").catch(() => null);

        const widgetName = node.type === CROP_STITCH_NODE ? "image_out" : node.type === MASK_NODE ? "mask_out" : "image";
        applyImageToNode(node, info, widgetName);

        // 缩略图 / 下游预览要和节点实际输出一致：alpha 就显示原图（透明区如实透明），
        // 选了底色就在服务端按这个颜色垫一张，只用于显示，不改节点引用的文件。
        const displayInfo = background === "alpha" ? info : await colorPreview(node, info, background);
        if (displayInfo?.name) setNodePreview(node, displayInfo);
        console.log("[PhotoCraft] 已回传图片到节点", node.id, info, "background=" + background);

        // 顺手把图 / 遮罩推给直接相连的下游预览节点，省掉一轮队列
        if (widgetName !== "mask_out") {
            // 遮罩由服务端按 1-alpha 生成，和节点 MASK 输出一致
            const maskInfo = await requestMaskPreview(node, info, true);
            pushPreviewToDownstream(node, displayInfo || info, maskInfo);
        }

        // 导出之后顺手把分层文档也存一份快照，下次打开就是这次的样子。
        const frame = document.getElementById(`${MODAL_ID}_frame`);
        if (frame?.contentWindow) setTimeout(() => requestDocSnapshot(frame.contentWindow), 800);
    } catch (e) {
        console.error("[PhotoCraft] 回传失败", e);
        alert(`PhotoCraft 图片回传失败：${e.message || e}`);
    }
});

/** 节点上的背景填充值；没有这个控件（其它节点）就当 alpha。 */
function backgroundOf(node) {
    const widget = node?.widgets?.find((w) => w.name === "background");
    return String(widget?.value || "alpha");
}

/** 按选定底色在服务端垫一张 RGB 图，仅用于缩略图 / 下游预览，不改节点引用的输入文件。 */
async function colorPreview(node, meta, color) {
    if (!meta?.filename) return meta;
    try {
        const response = await api.fetchApi("/photocraft/flatten", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                filename: meta.filename,
                subfolder: meta.subfolder || "",
                type: meta.type || "input",
                color,
                out: `photocraft_disp_${node.id}.png`,
            }),
        });
        if (!response.ok) return meta;
        const info = await response.json();
        if (!info?.name) return meta;
        return { name: info.name, subfolder: info.subfolder || "", type: info.type || "input" };
    } catch (e) {
        console.warn("[PhotoCraft] 底色预览生成失败", e);
        return meta;
    }
}

/** 合成节点上的 image 是把编辑器结果文件名带回来的内部状态，不显示成控件/端口。 */
function hideResultStorage(node, widgetName = "image") {
    const widget = node.widgets?.find((w) => w.name === widgetName);
    if (widget && !widget.__pcHidden) {
        widget.__pcHidden = true;
        widget.computeSize = () => [0, -4];
        widget.draw = () => {};
    }
    const socketIndex = (node.inputs || []).findIndex((input) => input?.name === widgetName);
    if (socketIndex >= 0) node.removeInput(socketIndex, true);
}

// =============================================== 裁切图按 stitch 记录贴回原位

function upstreamNode(node, inputName) {
    const input = (node.inputs || []).find((x) => x?.name === inputName);
    if (!input || input.link == null) return null;
    const link = app.graph.links?.[input.link] ?? app.graph.links?.get?.(input.link);
    return link ? app.graph.getNodeById(link.origin_id) : null;
}

function widgetValue(node, name) {
    return node?.widgets?.find?.((w) => w.name === name)?.value;
}

/**
 * 顺着 stitch 找到裁切框：Image_mask_crop_visual 会把框的心点/缩放在 crop_state 里、
 * 原图尺寸在 ui 的 crop_meta 里，这里按它 Python 侧同一套公式换算成像素矩形。
 */
function cropRectFromStitch(srcNode, fallbackW, fallbackH) {
    if (!srcNode) return null;

    const cropW = Number(widgetValue(srcNode, "crop_width"));
    const cropH = Number(widgetValue(srcNode, "crop_height"));
    const stateText = widgetValue(srcNode, "crop_state");
    const byScaleRaw = widgetValue(srcNode, "crop_byScale");

    let state = {};
    try {
        state = typeof stateText === "string" ? JSON.parse(stateText) : stateText || {};
    } catch {
        state = {};
    }

    const meta = app.nodeOutputs?.[srcNode.id]?.crop_meta?.[0];
    // 没执行过就没有 crop_meta：裁切节点的输入图就是底图本身，尺寸直接拿底图的。
    const imgW = Number(meta?.img_w) || Number(fallbackW);
    const imgH = Number(meta?.img_h) || Number(fallbackH);
    if (!(imgW > 0 && imgH > 0 && cropW > 0 && cropH > 0)) return null;

    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
    const cx = clamp(Number(state.cx ?? 0.5), 0, 1);
    const cy = clamp(Number(state.cy ?? 0.5), 0, 1);
    const zoom = Math.max(1e-4, Number(state.zoom ?? 1));
    const byScale = typeof byScaleRaw === "boolean" ? byScaleRaw : String(byScaleRaw ?? true).toLowerCase() !== "false";

    if (!byScale) {
        const srcW = Math.min(imgW, cropW);
        const srcH = Math.min(imgH, cropH);
        let x0 = Math.round(cx * imgW - srcW / 2);
        let y0 = Math.round(cy * imgH - srcH / 2);
        x0 = Math.max(0, Math.min(imgW - srcW, x0));
        y0 = Math.max(0, Math.min(imgH - srcH, y0));
        return { x: x0, y: y0, w: srcW, h: srcH };
    }

    const fitZoom = Math.max(cropW / imgW, cropH / imgH, 1e-4);
    const z = Math.max(zoom, fitZoom);
    const srcW = Math.max(1, cropW / z);
    const srcH = Math.max(1, cropH / z);
    let cxPx = Math.min(imgW, Math.max(0, cx * imgW));
    let cyPx = Math.min(imgH, Math.max(0, cy * imgH));
    cxPx = Math.min(imgW - srcW / 2, Math.max(srcW / 2, cxPx));
    cyPx = Math.min(imgH - srcH / 2, Math.max(srcH / 2, cyPx));
    const left = cxPx - srcW / 2;
    const top = cyPx - srcH / 2;

    let x0 = Math.max(0, Math.floor(left));
    let y0 = Math.max(0, Math.floor(top));
    let x1 = Math.min(imgW, Math.ceil(left + srcW));
    let y1 = Math.min(imgH, Math.ceil(top + srcH));
    if (x1 <= x0) x1 = Math.min(imgW, x0 + 1);
    if (y1 <= y0) y1 = Math.min(imgH, y0 + 1);
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** 底图（原图）的来源：优先节点上接的 image，其次 stitch 节点给的 bg_image / 它自己的 image 上游。 */
function bottomSourceOf(node) {
    const direct = describeSource(upstreamNode(node, "image"));
    if (direct) return direct;

    const stitchSource = upstreamNode(node, "stitch");
    const bg = app.nodeOutputs?.[stitchSource?.id]?.bg_image?.[0];
    if (bg?.filename) return { filename: bg.filename, subfolder: bg.subfolder || "", type: bg.type || "temp" };

    return describeSource(upstreamNode(stitchSource, "image"));
}

function viewUrlOf(meta) {
    const name = String(meta.filename || "").split("/").pop();
    const subfolder = meta.subfolder || "";
    return api.apiURL(
        `/view?filename=${encodeURIComponent(name)}&type=${encodeURIComponent(
            meta.type || "input",
        )}&subfolder=${encodeURIComponent(subfolder)}&rand=${Date.now()}`,
    );
}

async function loadBitmap(meta) {
    const response = await fetch(viewUrlOf(meta), { cache: "no-store" });
    if (!response.ok) throw new Error(`取图失败：HTTP ${response.status}（${meta.filename}）`);
    const blob = await response.blob();
    return await createImageBitmap(blob);
}

/**
 * 交给编辑器之前把 alpha 抹平：上游文件可能是带透明洞的 RGBA（比如 clipspace 的 masked 图），
 * 直接当图层打开会看到“洞”，导出也带 alpha，看起来就像把 MASK 并进了图里。
 * IMAGE 的通道只跟源文件走、不把 MASK 算进来，所以这里保留 RGB、把 alpha 写成 255。
 * 必须在服务端做：浏览器画布是预乘 alpha，alpha=0 处的 RGB 会被抹成黑，只有 PIL 能取回隐藏的 RGB。
 */
async function opaqueSource(node, meta, slotKey, opts = {}) {
    if (!meta?.filename) return meta;
    // 抹平失败必须显式报错：静默回退成原 RGBA 文件，编辑器里就会看到"洞"，
    // 看起来像把 MASK 并进了图片层（已经踩过一次）。
    const bail = (message) => {
        if (opts.required) throw new Error(message);
        console.warn("[PhotoCraft] 抹平 alpha 失败：", message, meta.filename);
        return meta;
    };
    try {
        const response = await api.fetchApi("/photocraft/flatten", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                filename: meta.filename,
                subfolder: meta.subfolder || "",
                type: meta.type || "input",
                out: `photocraft_flat_${node.id}_${slotKey}.png`,
            }),
        });
        if (!response.ok) {
            let detail = "";
            try {
                const body = await response.json();
                detail = body?.error || "";
            } catch {
                detail = "";
            }
            return bail(`服务端拒绝抹平 alpha（HTTP ${response.status}${detail ? "：" + detail : ""}）`);
        }
        const info = await response.json();
        if (!info?.name) return bail("抹平 alpha 没拿到文件名");
        if (info.name !== meta.filename) {
            console.log("[PhotoCraft] 抹平 alpha", meta.filename, "→", info.name);
        }
        return {
            filename: info.name,
            subfolder: info.subfolder || "",
            type: info.type || "input",
        };
    } catch (e) {
        if (opts.required) throw e;
        console.warn("[PhotoCraft] 抹平 alpha 请求异常", e);
        return meta;
    }
}

/** 按顺序把一串图片来源抹平 alpha（文件名固定，多次打开不会不停堆文件）。 */
async function opaqueSources(node, list) {
    const out = [];
    for (let index = 0; index < (list || []).length; index += 1) {
        out.push(await opaqueSource(node, list[index], `l${index + 1}`, {}));
    }
    return out;
}

/**
 * 把裁切图按裁剪矩形画到与底图同尺寸的透明画布上，作为独立图层。
 * 这样即使编辑器把新图层放到画布正中，位置也正好等于 (0,0) 对齐。
 */
async function buildPositionedLayer(source, rect, docW, docH) {
    const canvas = document.createElement("canvas");
    canvas.width = docW;
    canvas.height = docH;
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(source, rect.x, rect.y, rect.w, rect.h);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("生成图层失败");
    return blob;
}

/**
 * 裁切图层的像素来源：
 * 1) 上游节点执行过、有真实文件（预览/保存节点、或本节点上次运行的 crop 缓存）→ 直接用那个文件；
 * 2) 上游就是裁切节点本身（输出=原图按框裁出来的块）→ 用底图按同一个框重裁一遍，结果与裁切节点一致。
 */
async function cropPatchSource(node, stitchNode, cropRect, outW, outH, docBitmap) {
    const src = upstreamNode(node, "inpainted_image");
    const plainCrop = Boolean(src && src === stitchNode && widgetValue(src, "crop_width") != null);

    if (!plainCrop) {
        const meta = app.nodeOutputs?.[src?.id]?.images?.[0] || app.nodeOutputs?.[node.id]?.photocraft_crop?.[0];
        if (meta?.filename) return { source: await loadBitmap(meta), kind: "file" };
    }

    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(outW));
    canvas.height = Math.max(1, Math.round(outH));
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(docBitmap, cropRect.x, cropRect.y, cropRect.w, cropRect.h, 0, 0, canvas.width, canvas.height);
    return { source: canvas, kind: "original" };
}

/** 裁切缝合节点：底图=原图，上层=按 stitch 记录贴回原位的裁切图。 */
async function openPhotoCraftCropStitch(node) {
    const stitchNode = upstreamNode(node, "stitch");
    console.log("[PhotoCraft] 裁切缝合打开", node.id, "stitch 源", stitchNode?.id, stitchNode?.type);
    if (!stitchNode) {
        alert("请把裁切节点的 stitch（STITCH2）输出接到本节点的 stitch 输入，再打开编辑器。");
        return;
    }

    const cropSource = describeSource(upstreamNode(node, "inpainted_image"));
    let bottomSource = bottomSourceOf(node);
    if (!bottomSource) {
        alert("找不到原图：请把原图接到 image 输入，或确认 stitch 的上游是裁切节点。");
        return;
    }
    // 底图原样交付（含 alpha 的 RGBA 就带着 alpha 进去，不改上游数据）
    rememberSources(node, [bottomSource, cropSource]);

    let docBitmap;
    try {
        docBitmap = await loadBitmap(bottomSource);
    } catch (e) {
        alert(`取原图失败：${e.message || e}`);
        return;
    }

    const docW = docBitmap.width;
    const docH = docBitmap.height;
    const baseRect = cropRectFromStitch(stitchNode, docW, docH);
    console.log("[PhotoCraft] 底图", docW + "×" + docH, "裁切框", baseRect);
    if (!baseRect) {
        alert("读不到裁剪范围：请确认裁切节点的 crop_width / crop_height / crop_state 已设置。");
        docBitmap.close?.();
        return;
    }

    const rect = baseRect;
    const outW = Number(widgetValue(stitchNode, "crop_width")) || rect.w;
    const outH = Number(widgetValue(stitchNode, "crop_height")) || rect.h;

    const fingerprint = JSON.stringify({
        v: 4,
        bottom: bottomSource,
        crop: cropSource,
        rect,
        out: [outW, outH],
    });
    const doc = await resolveCachedDoc(node, fingerprint);
    if (doc) {
        docBitmap.close?.();
        await openPhotoCraft(node, null, `恢复上次编辑（${doc.filename}）`, doc);
        return;
    }

    try {
        const patch = await cropPatchSource(node, stitchNode, baseRect, outW, outH, docBitmap);
        const layerBlob = await buildPositionedLayer(patch.source, rect, docW, docH);
        const bytes = new Uint8Array(await layerBlob.arrayBuffer());
        const info = await uploadToInput(bytes, `photocraft_layer_${node.id}.png`, "image/png");
        const layerMeta = {
            filename: info.name,
            subfolder: info.subfolder || "",
            type: info.type || "input",
        };

        node.properties = node.properties || {};
        node.properties.photocraft_inputs = fingerprint;
        node.properties.photocraft_doc = "";

        const offsetText = rect.x || rect.y ? `，贴回位置 ${rect.x}, ${rect.y}` : "";
        const sourceText = patch.kind === "file" ? "" : "，裁切块取自原图";
        await openPhotoCraft(
            node,
            [bottomSource, layerMeta],
            `原图 + 裁切图层（${docW}×${docH}，裁切块 ${outW}×${outH}${offsetText}${sourceText}）`,
        );
    } catch (e) {
        console.error("[PhotoCraft] 裁切缝合图层生成失败", e);
        alert(`裁切图层生成失败：${e.message || e}`);
    } finally {
        docBitmap.close?.();
    }
}

// =============================================== 遮罩画布（黑白：白 = 遮罩内）

/** 遮罩图的文件来源：本节点上次运行落下的、或 mask 上游节点带预览输出的。 */
function maskSourceOf(node) {
    const own = app.nodeOutputs?.[node.id]?.photocraft_mask?.[0];
    if (own?.filename) {
        return { filename: own.filename, subfolder: own.subfolder || "", type: own.type || "temp" };
    }
    const up = app.nodeOutputs?.[upstreamNode(node, "mask")?.id]?.images?.[0];
    if (up?.filename) return { filename: up.filename, subfolder: up.subfolder || "", type: up.type || "temp" };
    return null;
}

/** 把遮罩按亮度摊成灰度画布（白 = 遮罩内、黑 = 遮罩外），并缩放到图片尺寸。 */
async function buildMaskGrayCanvas(maskMeta, docW, docH) {
    const bitmap = await loadBitmap(maskMeta);
    const src = document.createElement("canvas");
    src.width = bitmap.width;
    src.height = bitmap.height;
    const sctx = src.getContext("2d");
    sctx.drawImage(bitmap, 0, 0);

    const pixels = sctx.getImageData(0, 0, src.width, src.height);
    const count = src.width * src.height;
    for (let i = 0; i < count; i += 1) {
        // 遮罩存成灰度图时 alpha 也可能是满的，所以取最亮通道，手误涂彩色也算进遮罩
        const v = Math.max(pixels.data[i * 4], pixels.data[i * 4 + 1], pixels.data[i * 4 + 2]);
        pixels.data[i * 4] = v;
        pixels.data[i * 4 + 1] = v;
        pixels.data[i * 4 + 2] = v;
        pixels.data[i * 4 + 3] = 255;
    }
    sctx.putImageData(pixels, 0, 0);

    const canvas = document.createElement("canvas");
    canvas.width = docW;
    canvas.height = docH;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, docW, docH);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(src, 0, 0, src.width, src.height, 0, 0, docW, docH);
    bitmap.close?.();
    return canvas;
}

/** 画布内容的粗略指纹：同一份遮罩重跑多次文件名会变，靠采样值判断是不是同一张。 */
function canvasChecksum(canvas) {
    const ctx = canvas.getContext("2d");
    const step = Math.max(1, Math.floor(Math.min(canvas.width, canvas.height) / 64));
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let sum = 0;
    for (let y = 0; y < canvas.height; y += step) {
        for (let x = 0; x < canvas.width; x += step) {
            sum = (sum + data[(y * canvas.width + x) * 4]) % 1000003;
        }
    }
    return `${canvas.width}x${canvas.height}:${sum}`;
}

/**
 * 上层 Alpha 图层：透明画布 + 纯黑 RGB，alpha 直接等于遮罩值——
 * 遮罩内（白）→ 不透明纯黑，遮罩外（黑）→ 全透明（什么都不盖），中灰 → 半透明。
 * 出图时遮罩 = 图层 alpha，图片本身直通底图。
 */
async function buildMaskLayerCanvas(maskMeta, docW, docH) {
    const gray = await buildMaskGrayCanvas(maskMeta, docW, docH);

    const canvas = document.createElement("canvas");
    canvas.width = docW;
    canvas.height = docH;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    // 空白透明底，不要整幅黑：遮罩外必须什么都没有，才是一张"干净的"alpha 层
    ctx.clearRect(0, 0, docW, docH);

    const grayData = gray.getContext("2d").getImageData(0, 0, docW, docH).data;
    const layer = ctx.createImageData(docW, docH);
    const pixels = layer.data;
    const count = docW * docH;
    for (let i = 0; i < count; i += 1) {
        // RGB 纯黑，alpha 直接就是遮罩值：白（遮罩内）→ 不透明，黑（遮罩外）→ 全透明，中灰 → 半透明
        const g = grayData[i * 4];
        pixels[i * 4] = 0;
        pixels[i * 4 + 1] = 0;
        pixels[i * 4 + 2] = 0;
        pixels[i * 4 + 3] = g;
    }
    ctx.putImageData(layer, 0, 0);
    return { canvas, gray };
}

/** 遮罩节点：原图 + alpha 遮罩图层，编辑后导出，image / mask 一起回写。 */
async function openPhotoCraftMask(node) {
    let origSource = describeSource(upstreamNode(node, "image"));
    if (!origSource) {
        alert("请把图片接到 image 输入（用它的尺寸做画布）。");
        return;
    }
    // 原图像素当图层内容，alpha 抹平（遮罩只由 mask 决定，不从图里取）
    let imageSource;
    try {
        imageSource = await opaqueSource(node, origSource, "maskimg", { required: true });
    } catch (e) {
        alert(`图片层准备失败：${e.message || e}\n（不会把带透明洞的原图直接当图层打开）`);
        return;
    }
    const maskMeta = maskSourceOf(node);
    if (!maskMeta) {
        alert("还没拿到遮罩图：先运行一次（Ctrl+Enter）让遮罩生成，再点「编辑遮罩」。");
        return;
    }

    let imageBitmap;
    try {
        imageBitmap = await loadBitmap(imageSource);
    } catch (e) {
        alert(`取图失败：${e.message || e}`);
        return;
    }
    const docW = imageBitmap.width;
    const docH = imageBitmap.height;
    imageBitmap.close?.();

    let built;
    try {
        built = await buildMaskLayerCanvas(maskMeta, docW, docH);
    } catch (e) {
        alert(`遮罩图层生成失败：${e.message || e}`);
        return;
    }

    const fingerprint = JSON.stringify({
        v: 3,
        // 原始来源 + 抹平后的文件名都进指纹：换了上游图但槽位名没变时，
        // 旧快照（可能带着洞的底图）会因此失效，按新图重建文档。
        image: [origSource.filename, imageSource.filename],
        size: [docW, docH],
        mask: canvasChecksum(built.gray),
    });
    const doc = await resolveCachedDoc(node, fingerprint);
    if (doc) {
        await openPhotoCraft(node, null, `恢复上次编辑（${doc.filename}）`, doc);
        return;
    }

    try {
        const blob = await new Promise((resolve) => built.canvas.toBlob(resolve, "image/png"));
        if (!blob) throw new Error("导出遮罩图层失败");
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const info = await uploadToInput(bytes, `photocraft_masklayer_${node.id}.png`, "image/png");
        const layerMeta = {
            filename: info.name,
            subfolder: info.subfolder || "",
            type: info.type || "input",
        };

        node.properties = node.properties || {};
        node.properties.photocraft_inputs = fingerprint;
        node.properties.photocraft_doc = "";

        await openPhotoCraft(
            node,
            [imageSource, layerMeta],
            `原图 + Alpha 遮罩层（${docW}×${docH}，遮罩内 = 纯黑不透明，遮罩外 = 透明）`,
        );
    } catch (e) {
        console.error("[PhotoCraft] 遮罩图层上传失败", e);
        alert(`遮罩图层上传失败：${e.message || e}`);
    }
}

/** 去掉扩展名和 ` [input]` 标注后的名字，用来判断“是不是同一张图”。 */
function stemOf(name) {
    return String(name || "")
        .replace(/\s*\[(input|output|temp)\]\s*$/i, "")
        .replace(/\.[a-z0-9]+$/i, "");
}

/** 编辑器自己回写出来的图，形如 <原名>_edit_<时间戳>.png。 */
function isEditorExport(name) {
    return /_edit_\d+$/i.test(stemOf(name));
}

/** 单图节点：有上次编辑的快照就恢复它，否则打开节点当前这张图。 */
async function openPhotoCraftSingle(node) {
    const raw = currentImage(node);
    const props = (node.properties = node.properties || {});
    // 记住“用户真正接进来的那张图”；导出的回写图不能覆盖它
    const origin = props.photocraft_origin || (isEditorExport(raw) ? "" : raw);

    // 导出会把 xxx.png 改写成 xxx_edit_<ts>.png，如果据此判断输入变了，
    // 下次打开就只会看到一张扁平图、图层全丢。所以回写图和原图都算“同一份输入”。
    const sameInput = !origin || origin === raw || isEditorExport(raw);

    if (props.photocraft_doc && sameInput) {
        const doc = await resolveCachedDoc(node, props.photocraft_inputs || "");
        if (doc) {
            await openPhotoCraft(node, null, `恢复上次编辑（${doc.filename}）`, doc);
            return;
        }
    }

    if (!origin) props.photocraft_origin = raw || "";

    let source = null;
    if (raw) {
        // 交给编辑器之前把 alpha 抹平：编辑器里看到的是完整画面，不会出现透明洞
        source = splitAnnotated(raw);
        if (!source.filename) source = null;
    }
    const fingerprint = source ? JSON.stringify({ v: 6, raw: props.photocraft_origin, source }) : "";

    props.photocraft_inputs = fingerprint;
    props.photocraft_doc = "";
    rememberSources(node, source ? [source] : null);
    await openPhotoCraft(node, source ? [source] : null, raw);
}

app.registerExtension({
    name: "PhotoCraft.Nodes",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (
            nodeData.name !== LOAD_NODE &&
            nodeData.name !== COMBINE_NODE &&
            nodeData.name !== CROP_STITCH_NODE &&
            nodeData.name !== MASK_NODE
        )
            return;

        const isCombine = nodeData.name === COMBINE_NODE;
        const isCropStitch = nodeData.name === CROP_STITCH_NODE;
        const isMask = nodeData.name === MASK_NODE;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            onNodeCreated?.apply(this, arguments);
            const label = isCombine
                ? "打开多图层"
                : isCropStitch
                  ? "原图 + 裁切图层"
                  : isMask
                    ? "编辑遮罩"
                    : "打开编辑器";
            const button = this.addWidget("button", "用 PhotoCraft 编辑", label, () =>
                isCombine
                    ? openPhotoCraftCombine(this)
                    : isCropStitch
                      ? openPhotoCraftCropStitch(this)
                      : isMask
                        ? openPhotoCraftMask(this)
                        : openPhotoCraftSingle(this),
            );
            button.options = { ...button.options, class: "queue-button" };
            if (isCombine) {
                hideResultStorage(this);
                syncCombineInputs(this);
                chainAllPreviews(this);
            }
            if (isCropStitch) {
                hideResultStorage(this, "image_out");
                chainAllPreviews(this);
            }
            if (isMask) {
                hideResultStorage(this, "mask_out");
            }
        };

        if (isCombine) {
            const onConnectionsChange = nodeType.prototype.onConnectionsChange;
            nodeType.prototype.onConnectionsChange = function (type, index, connected, link_info) {
                onConnectionsChange?.apply(this, arguments);
                // type 1 = 输入端：新接上的图片先串一个 Preview Image 再进合成端口
                if (type === 1 && connected && !chainingPreview) {
                    setTimeout(() => chainPreviewBefore(this, index), 0);
                }
                if (type === 1) syncCombineInputs(this);
            };

            const onConfigure = nodeType.prototype.onConfigure;
            nodeType.prototype.onConfigure = function () {
                onConfigure?.apply(this, arguments);
                hideResultStorage(this);
                chainAllPreviews(this);
            };
        }

        if (isCropStitch) {
            const onConnectionsChange = nodeType.prototype.onConnectionsChange;
            nodeType.prototype.onConnectionsChange = function (type, index, connected, link_info) {
                onConnectionsChange?.apply(this, arguments);
                // 只处理 inpainted_image 这根图片输入：新接上时先串一个 Preview Image
                const name = String(this.inputs?.[index]?.name || "");
                if (type === 1 && connected && !chainingPreview && isCropStitchSlotName(name)) {
                    setTimeout(() => chainPreviewBefore(this, index), 0);
                }
            };

            const onConfigure = nodeType.prototype.onConfigure;
            nodeType.prototype.onConfigure = function () {
                onConfigure?.apply(this, arguments);
                hideResultStorage(this, "image_out");
                chainAllPreviews(this);
            };
        }

        // 右键菜单：丢掉上次的编辑缓存，按当前输入重新载入。
        const getExtraMenuOptions = nodeType.prototype.getExtraMenuOptions;
        nodeType.prototype.getExtraMenuOptions = function (canvas, options) {
            getExtraMenuOptions?.apply(this, arguments);
            options.push({
                content: "清除编辑缓存（按输入重新载入）",
                callback: () => {
                    this.properties = this.properties || {};
                    this.properties.photocraft_doc = "";
                    this.properties.photocraft_inputs = "";
                    this.properties.photocraft_origin = "";
                    app.graph.setDirtyCanvas(true, true);
                    console.log("[PhotoCraft] 已清除节点", this.id, "的编辑缓存");
                },
            });
        };
    },
});
