# comfyui_PhotoCraft_node

把 [PhotoCraft](https://github.com/Storytold/photocraft)（一个用 Rust + WASM 写的浏览器端修图器）搬进 ComfyUI：点节点上的按钮，就在 ComfyUI 内部弹出带自定义边框的编辑器窗口，节点当前的图会**自动喂进去**，改完点「导出」，结果**自动传回节点**，不用手动下载再上传。

作者不是 PhotoCraft 的作者，本仓库只是 ComfyUI 侧的接入层（Python 节点 + 前端桥接 + 预编译的 PhotoCraft web 包）。

## 特性

- **图片全自动进出**：打开编辑器时节点当前图自动作为图层载入；导出后自动写回节点，节点预览同步刷新。
- **结果落在 ComfyUI\output**：导出/保存都不再触发浏览器下载，文件直接归档到 ComfyUI 的 `output` 目录；`input` 里另留一份同名工作副本供节点控件引用。两份内容不同：`output` 那份是**不透明**成图（透明区用上游原图垫底，谁打开都不会看到黑洞），`input` 那份保留原始 alpha，节点的 `MASK` 输出就从它算（`1 - alpha`）。
- **ComfyUI 内部弹窗**：不另开浏览器标签页。固定遮罩 + 圆角面板 + 自绘标题栏 + iframe，标题栏只保留最大化 / 关闭。
- **多图图层合成**：`photoCraft_image_combine` 端口按需生长（接一张就长出下一个，最多 32 个），在编辑器里按顺序叠成图层。
- **分层状态缓存**：编辑器本身不持久化，本插件在关闭弹窗前自动保存一份带图层的 PSD 快照到节点属性里，下次打开直接恢复上次的编辑现场；输入图变了才按新输入重开。
- **裁切回贴**：`photoCraft_crop_stitch` 接收 `STITCH2` 里的裁切框与位置，把裁切图定位成图层贴回原图，打开就是「原图 + 定位好的裁切层」。
- **中文界面**：编辑器界面默认 `zh-hans`，节点菜单/参数名带简体中文翻译（`locales/zh`）。

## 环境要求

- ComfyUI（较新版本，需支持自定义节点 `WEB_DIRECTORY` 与 `/i18n` 本地化目录）
- 浏览器需支持 **WebGPU**（Chrome / Edge 113+，或新版 Firefox / Safari），PhotoCraft 的渲染后端是 `wgpu`
- Python 依赖见 `requirements.txt`（`torch` / `numpy` / `Pillow` / `aiohttp` 由 ComfyUI 自带）

## 安装

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/<your-name>/comfyui_PhotoCraft_node.git
pip install -r comfyui_PhotoCraft_node/requirements.txt
```

重启 ComfyUI 即可。仓库里已经带了**预编译好的编辑器前端包**（`web/photocraft/`，来自 PhotoCraft v0.23.1 的官方 web 发行包），所以不需要 Rust / trunk 工具链。

如果 `web/photocraft/` 缺失（例如你手动清理过），节点会提示「PhotoCraft is not built」。两种补法：

1. 从 <https://github.com/Storytold/photocraft/releases> 下载 `photocraft-web-<版本>.zip`，解压后把**里面的内容**放到 `web/photocraft/`（`index.html` 必须直接位于 `web/photocraft/` 下）；
2. 或执行 `build_photocraft_web.ps1`（需要 `photocraft/` 源码完整 + trunk）。

## 节点

菜单分类：`Apt_Preset/PhotoCraft`（与 Apt_Preset 插件同菜单）。

### photoCraft_load_image — 加载图像

继承官方 `Load Image` 的行为，多一个「用 PhotoCraft 编辑」按钮。

| 输入 | 说明 |
| --- | --- |
| `image` | 图片文件名（含上传控件） |

输出 `IMAGE`（默认 RGB 3 通道）+ `MASK`。带 alpha 的源图，alpha 只走 MASK，不并进 IMAGE；编辑器导出结果在归档前已经合成成不透明 PNG，所以既没有黑斑，也不会凭空多出一个 MASK。

### photoCraft_image_combine — 多图层合成

| 输入 | 说明 |
| --- | --- |
| `image1` … `image32` | 可选图像端口，连一张自动长出下一个（最多 32） |
| `image` | 隐藏控件，存放编辑器回传的结果文件名 |

输出 `IMAGE` + `MASK`。

- **加载图像节点只出 RGB**：`PhotoCraft 加载图像` 的 `IMAGE` 输出固定 RGB 三通道，源文件带 alpha 时只从 `MASK` 端口出，绝不会把第 4 通道带到下游（ComfyUI 自带「遮罩编辑器」保存时会往图片里写 alpha，那种文件在这里会被裁成 RGB）。
- **通道由开关决定，不自动猜**：`alpha_mode` = `drop_alpha`（默认，输出 RGB 三通道，alpha 只走 `MASK`，与官方 Load Image 一致）/ `keep_alpha`（第 4 通道原样输出）。
- **不凭空造遮罩**：只有图本身带 alpha 时才由 alpha 生成 `MASK`（`1 - alpha`）；上游是 3 通道且没接任何遮罩时，`MASK` 输出全 0。
- 还没编辑过时直接透传第一个已连接的输入，方便先看到东西。
- 打开编辑器时把上游文件**原样**喂进去（该带 alpha 就带 alpha），不做抹平处理；RGBA 的透明区在编辑器里就是透明区。

### photoCraft_crop_stitch — 裁切回贴

端口顺序与 `Image_solo_stitch` 一致（`inpainted_image` / `mask` / `stitch`）。

| 输入 | 说明 |
| --- | --- |
| `inpainted_image` | 裁切后的图（要贴回去的那块） |
| `mask` | 遮罩，`crop_mask` 模式下只贴遮罩内的部分 |
| `stitch` | `STITCH2`，提供原图、裁切框、裁切位置 |
| `stitch_mode` | `crop_mask`（默认，只贴遮罩内）/ `crop_image`（整块裁切图贴回） |
| `feather` | 羽化边宽度（像素，0–500，默认 8），**只在 `crop_image` 下生效**，算法等价 `create_feather_mask`（四周向内线性衰减） |
| `image_out` | 隐藏控件，编辑器回传的结果文件名 |

打开编辑器时呈现为「原图（底图）+ 按公式定位好的裁切图层（尺寸 = 裁切块，位置 = `crop_position`）」。

## 使用流程

1. 接好上游，点节点上的 **用 PhotoCraft 编辑**。
2. 弹出 ComfyUI 内部编辑器，节点当前图作为图层自动载入；多图节点按连线顺序叠层。
3. 在编辑器里改（画笔、图层、滤镜等都在 PhotoCraft 里）。
4. 点编辑器左下（颜色块下方）的绿色 **导出** 按钮，或按 `Ctrl+Shift+E`：结果自动写回节点，并**归档到 `ComfyUI\output\`**（文件名形如 `原名_edit_<时间戳>.png`）。浏览器不会再弹出/产生下载文件。归档前会把导出图的透明区用上游原图垫底合成成不透明 PNG，所以下游看到的是完整画面、不会出现黑斑或"洞"。
5. 导出后若节点下游直接连的是 `Preview Image` 这类预览节点，**图像线和遮罩线都会立刻换成新结果**（不用再跑一次队列）：图像用 `output` 里的不透明结果，遮罩用临时灰度图（白 = 遮罩内，与节点 MASK 输出一致）。参与计算的节点仍需正常执行。
6. 关闭弹窗时会自动把**带图层的 PSD 快照**存进节点属性；下次打开直接恢复。想按新输入重开，右键节点 → **清除编辑缓存（按输入重新载入）**。

## 实现要点

- 编辑器页在 `web/photocraft/index.html`，前端桥接脚本 `web/photocraft/comfy_bridge.js` 只在编辑器页注入（避免画布页也长出按钮）。
- 载入方式：桥接脚本等加载遮罩消失后，用 `DataTransfer` 往 `#photocraft_canvas` 派发 `dragover` / `drop`，等价于用户手动拖图。
- 回传方式：钩住 `HTMLAnchorElement.prototype.click` 抓 `blob:` 下载，`postMessage` 给宿主。钩子里**不再放行浏览器下载**。宿主先 `POST /upload/image` 把字节暂存到 `input`，再 `POST /photocraft/opaque` 让服务端把导出 RGBA 按 alpha 叠到上游原图上（PhotoCraft 的 PNG 导出会把透明区压成黑色 RGB）合成不透明 PNG，同时写 `output`（归档）与 `input`（节点控件引用），随后刷新 `node.imgs`。通道模式选 `keep_alpha` 时跳过合成、原样归档带 alpha 的结果。分层 PSD 快照只写 `input`（纯缓存）。
- **快速导出 PNG 是扁平导出**（状态栏会提示 `layers, masks and blend modes are not kept`），所以需要保留图层/遮罩的节点走的是「导出 = 保存分层 PSD」这条路径，由 `psd_tools` 读回图层 alpha。
- 额外接口：`POST /photocraft/opaque`（导出结果合成不透明 PNG：透明区用上游原图垫底；同时写 output 与 input 两份）、`POST /photocraft/flatten`（把带透明洞的源图抹平成不透明 PNG）、`POST /photocraft/maskpreview`（生成遮罩灰度预览，`invert=true` 按 `1-alpha` 取反，与 MASK 输出一致）。

## 已知限制

- 编辑器依赖 WebGPU，浏览器不支持时编辑器起不来。
- 导出不再触发浏览器下载；想拿到本地文件请去 `ComfyUI\output\`。同一张结果在 `input` 里也有一份同名副本（节点控件只认 input 目录），不需要时可以清掉。
- 关闭弹窗（✕ / Esc / 点面板外空白）都会先存一份分层快照再拆 iframe；快照回传到达即刻关闭（通常 < 1s），编辑器忙时应答慢则最多等 3s。
- PhotoCraft 的上游不支持「只导出当前图层」，扁平导出会丢 alpha，所以分层信息只能靠 PSD 快照保存。

## 目录结构

```
comfyui_PhotoCraft_node/
├─ __init__.py                # 节点注册 + WEB_DIRECTORY
├─ nodes.py                   # Python 节点与自定义 HTTP 接口
├─ requirements.txt
├─ build_photocraft_web.ps1   # 可选：本地编译编辑器前端（需要 trunk）
├─ locales/zh/                # 简体中文本地化（main.json + nodeDefs.json）
├─ web/
│  ├─ photocraft_load_image.js   # 画布侧扩展：按钮 / 弹窗 / 缓存 / 导出回写
│  └─ photocraft/                # PhotoCraft 预编译 web 包（含 comfy_bridge.js）
└─ photocraft/                # 可选：上游 Rust 源码（发布时可不带，体积大）
```

## 许可

本仓库的接入层代码为 **MIT**（见 `LICENSE`，版权署名 `PhotoCraft Node Contributors`）。

内置的 `web/photocraft/` 是 [PhotoCraft](https://github.com/Storytold/photocraft) v0.23.1 的预编译 web 发行包，按上游 **MIT OR Apache-2.0** 分发，完整许可证与第三方声明保留在包内（`LICENSE-MIT`、`LICENSE-APACHE`、`NOTICE`、`ATTRIBUTION.md`）。PhotoCraft 的名称与版权归其原作者所有。

## English

A ComfyUI node pack that embeds [PhotoCraft](https://github.com/Storytold/photocraft) (a Rust/WASM image editor) as an in-app modal inside ComfyUI. Click **Edit with PhotoCraft** on a node, the node's current image is fed into the editor automatically as a layer, hit **Export**, and the result is written back into the node and archived into ComfyUI's `output` folder — no browser download, no manual save/upload.

Nodes: `photoCraft_load_image`, `photoCraft_image_combine` (up to 32 auto-growing image slots, layered in the editor), `photoCraft_crop_stitch` (repositions a cropped patch per `STITCH2`, with `crop_mask` / `crop_image` modes and a feather edge).

Requires a WebGPU-capable browser. A prebuilt editor bundle (PhotoCraft v0.23.1 web release) ships in `web/photocraft/`, so no Rust/trunk toolchain is needed. Layered edits are persisted as PSD snapshots stored in node properties, so closing and reopening the modal restores the previous editing session.

Licensed MIT for this integration layer; bundled PhotoCraft is MIT OR Apache-2.0 (see `web/photocraft/`).
