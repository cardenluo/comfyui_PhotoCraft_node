import os
import re
import shutil

import folder_paths
import numpy as np
import torch
import torch.nn.functional as F
from PIL import Image, ImageOps
from nodes import LoadImage


class PhotoCraftLoadImage(LoadImage):
    """官方 Load Image 的行为，多一个在前端打开 PhotoCraft 编辑器的按钮。

    IMAGE 输出强制 RGB 3 通道（官方实现本身就是 convert("RGB")）；源文件带 alpha 时，
    alpha 只走单独的 MASK 输出，不并进 IMAGE。
    """

    CATEGORY = "Apt_Preset/PhotoCraft"

    def load_image(self, image):
        """IMAGE 永远只出 RGB 三通道。

        源文件自带 alpha 的情况（例如 ComfyUI 自带「遮罩编辑器」保存时会把遮罩写进图片的
        alpha）在上游就会被当成 4 通道，下游预览里那圈透明区看起来就像"遮罩被并进了图片"。
        这里统一裁到 RGB：alpha 只从 MASK 端口出去，IMAGE 线上不出现第 4 通道。
        """
        images, mask = super().load_image(image)
        if int(images.shape[-1]) > 3:
            images = images[..., :3].contiguous()
        return (images, mask)


class PhotoCraftImageCombine:
    """多个图片端口 + PhotoCraft 编辑器：把接进来的图在编辑器里以多图层打开、合成，
    导出后回传成一张图，作为本节点的输出。"""

    MAX_INPUTS = 32

    # 背景填充：alpha = 原样保留第 4 通道；其余颜色把透明区垫成纯色、输出 3 通道
    BACKGROUNDS = ["alpha", "white", "black", "red", "green", "blue", "gray"]
    BACKGROUND_COLORS = {
        "white": (1.0, 1.0, 1.0),
        "black": (0.0, 0.0, 0.0),
        "red": (1.0, 0.0, 0.0),
        "green": (0.0, 1.0, 0.0),
        "blue": (0.0, 0.0, 1.0),
        "gray": (0.5, 0.5, 0.5),
    }

    @classmethod
    def INPUT_TYPES(cls):
        optional = {f"image{i}": ("IMAGE",) for i in range(1, cls.MAX_INPUTS + 1)}
        # 编辑器回传的结果文件名（由前端写入），空表示还没编辑过
        optional["image"] = ("STRING", {"default": "", "multiline": False, "tooltip": "PhotoCraft 导出的合成图（归档在 output，input 留同名副本）"})
        optional["background"] = (
            cls.BACKGROUNDS,
            {
                "default": "alpha",
                "tooltip": "alpha = 透明区原样保留（有 alpha 出 4 通道，没有出 3 通道）；白/黑/红/绿/蓝/灰 = 把透明区垫成该纯色，出 3 通道",
            },
        )
        return {"required": {}, "optional": optional}

    RETURN_TYPES = ("IMAGE", "MASK")
    RETURN_NAMES = ("image", "mask")
    FUNCTION = "combine"
    CATEGORY = "Apt_Preset/PhotoCraft"

    @classmethod
    def IS_CHANGED(cls, image="", background="alpha", **kwargs):
        # 同一张合成图会重复出图；按文件名 + 各输入指纹判断是否需要重算
        parts = [str(image), str(background)]
        for key, value in sorted(kwargs.items()):
            if isinstance(value, torch.Tensor):
                parts.append(f"{key}:{tuple(value.shape)}:{float(value.float().mean()):.6f}")
        return "|".join(parts)

    @staticmethod
    def _load_image_file(path):
        """按文件本身的通道读：文件是 RGB 就给 3 通道，是 RGBA 就给 4 通道，不裁不补。
        文件自带 alpha 时，额外返回 1-alpha 作为默认遮罩；没有 alpha 就返回 None。"""
        image = Image.open(path)
        image = ImageOps.exif_transpose(image)
        if image.mode == "I":
            image = image.point(lambda x: x * (1 / 255))

        has_alpha = "A" in image.getbands() or (image.mode == "P" and "transparency" in image.info)
        if has_alpha:
            rgba = np.array(image.convert("RGBA")).astype(np.float32) / 255.0
            image_tensor = torch.from_numpy(rgba)[None,]
            mask_tensor = (1.0 - torch.from_numpy(rgba[..., 3])).clamp(0.0, 1.0).unsqueeze(0)
            return image_tensor, mask_tensor

        rgb = np.array(image.convert("RGB")).astype(np.float32) / 255.0
        return torch.from_numpy(rgb)[None,], None

    @staticmethod
    def _apply_background(img, background):
        """background=alpha：原样输出（文件有 alpha 就 4 通道）；选了颜色：透明区垫成该纯色、出 3 通道。
        只按用户选的开关改通道，其他情况一律不动上游数据。"""
        if img.ndim == 3:
            img = img[None,]
        if background not in PhotoCraftImageCombine.BACKGROUND_COLORS or int(img.shape[-1]) < 4:
            return img
        color = PhotoCraftImageCombine.BACKGROUND_COLORS[background]
        rgb = img[..., :3]
        alpha = img[..., 3:4]
        fill = torch.tensor(color, dtype=rgb.dtype, device=rgb.device).reshape(1, 1, 1, 3)
        return (rgb * alpha + fill * (1.0 - alpha)).clamp(0.0, 1.0)

    def combine(self, image="", background="alpha", **kwargs):
        def collect(prefix):
            found = []
            for key, value in kwargs.items():
                if not key.startswith(prefix) or not isinstance(value, torch.Tensor):
                    continue
                suffix = key[len(prefix):]
                if not suffix.isdigit():
                    continue
                found.append((int(suffix), value))
            found.sort(key=lambda item: item[0])
            return [value for _index, value in found]

        images = collect("image")

        # 1) 有 PhotoCraft 回传的合成图：图像通道跟着文件走，只在选了背景色时垫色
        if image:
            path = folder_paths.get_annotated_filepath(image)
            if not os.path.exists(path):
                path = os.path.join(folder_paths.get_input_directory(), image)
            if os.path.exists(path):
                img, alpha_mask = self._load_image_file(path)
                height, width = int(img.shape[1]), int(img.shape[2])
                mask = alpha_mask if alpha_mask is not None else torch.zeros(1, height, width)
                return (self._apply_background(img, background).contiguous(), mask)

        # 2) 还没编辑过：透传第一个端口，通道完全跟着上游走
        #    （去 alpha 由前端在每个输入前自动串的 Preview Image 负责，节点自己不加工）
        if images:
            img = images[0]
            if img.ndim == 3:
                img = img[None,]
            height, width = int(img.shape[1]), int(img.shape[2])
            mask = (1.0 - img[0, ..., 3]).clamp(0.0, 1.0).unsqueeze(0) if int(img.shape[-1]) >= 4 else torch.zeros(1, height, width)
            return (self._apply_background(img, background).contiguous(), mask)

        raise ValueError("photoCraft_image_combine: 请至少连接一个图片端口 image1，或先用 PhotoCraft 编辑器导出一次")


class PhotoCraftCropStitch:
    """裁切图 + 拼接信息：底图是原图，上层是按 STITCH2 记录贴回原位的裁切图，
    用 PhotoCraft 打开就是「原图 + 定位好的裁切图层」，编辑后导出写回。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "inpainted_image": ("IMAGE",),
                "mask": ("MASK",),
                "stitch": ("STITCH2",),
                # 贴回方式（与 Image_solo_stitch 对齐）：
                # crop_mask = 只贴遮罩内的部分；crop_image = 整块裁切图贴回
                "stitch_mode": (["crop_mask", "crop_image"], {"default": "crop_mask"}),
            },
            "optional": {
                # 编辑器回传的结果文件名（由前端写入），空表示还没编辑过
                "image_out": ("STRING", {"default": "", "multiline": False}),
                # 羽化边宽度（像素，等价于 Image_solo_stitch 的 smoothness，只在 crop_image 下生效）。
                # 放在 optional 尾部：老工作流里这个控件没有值，加载时直接取默认，不会挤掉 image_out。
                "feather": ("INT", {"default": 8, "min": 0, "max": 500, "step": 1}),
            },
        }

    RETURN_TYPES = ("IMAGE", "MASK")
    RETURN_NAMES = ("image", "mask")
    FUNCTION = "stitch"
    CATEGORY = "Apt_Preset/PhotoCraft"

    @classmethod
    def IS_CHANGED(cls, image_out="", stitch_mode="crop_mask", feather=8, **kwargs):
        parts = [str(image_out), str(stitch_mode), str(feather)]
        for key, value in sorted(kwargs.items()):
            if isinstance(value, torch.Tensor):
                parts.append(f"{key}:{tuple(value.shape)}:{float(value.float().mean()):.6f}")
        return "|".join(parts)

    @staticmethod
    def _feather_mask(height, width, feather_size):
        """四周向内线性衰减的羽化 alpha（等价 Image_solo_stitch 的 create_feather_mask）。"""
        if not feather_size or feather_size <= 0:
            return torch.ones((height, width), dtype=torch.float32)
        f = min(int(feather_size), min(width, height) // 2)
        if f <= 0:
            return torch.ones((height, width), dtype=torch.float32)
        ys = torch.arange(height, dtype=torch.float32)
        xs = torch.arange(width, dtype=torch.float32)
        dy = torch.minimum(ys, (height - 1) - ys).view(-1, 1)  # (h,1)
        dx = torch.minimum(xs, (width - 1) - xs).view(1, -1)  # (1,w)
        d = torch.minimum(dy, dx).expand(height, width).contiguous()
        return (d / float(f)).clamp(0.0, 1.0)

    @staticmethod
    def _load_image_file(path):
        return PhotoCraftImageCombine._load_image_file(path)

    @staticmethod
    def _save_temp_png(tensor, prefix="photocraft_crop"):
        """把张量第一张贴到 temp 目录，供前端 Photocraft 取这张裁切图当图层。"""
        try:
            import time

            arr = (255.0 * tensor[0, :, :, :3].detach().cpu().numpy()).clip(0, 255).astype(np.uint8)
            name = f"{prefix}_{int(time.time() * 1000)}.png"
            Image.fromarray(arr).save(os.path.join(folder_paths.get_temp_directory(), name))
            return {"filename": name, "subfolder": "", "type": "temp"}
        except Exception:
            return None

    def stitch(self, inpainted_image, mask, stitch, stitch_mode="crop_mask", feather=8, image_out=""):
        # 1) 有 PhotoCraft 回传的合成图，以它为准
        if image_out:
            path = folder_paths.get_annotated_filepath(image_out)
            if not os.path.exists(path):
                path = os.path.join(folder_paths.get_input_directory(), image_out)
            if os.path.exists(path):
                return {"ui": {}, "result": self._load_image_file(path)}

        # 2) 还没编辑过：原图 + 按 stitch 定位的裁切图，合成一张返回
        data = stitch if isinstance(stitch, dict) else {}
        base = data.get("original_image")
        if not isinstance(base, torch.Tensor):
            base = data.get("bj_image")
        if not isinstance(base, torch.Tensor):
            raise ValueError("photoCraft_crop_stitch: stitch 里没有原图，请确认上游是裁切可视化节点")

        crop = inpainted_image
        if crop.ndim == 3:
            crop = crop[None,]
        if base.ndim == 3:
            base = base[None,]

        position = data.get("crop_position", (0, 0))
        size = data.get("crop_size", None)
        crop_x = int(position[0])
        crop_y = int(position[1])

        base_h, base_w = int(base.shape[1]), int(base.shape[2])
        crop_h, crop_w = int(crop.shape[1]), int(crop.shape[2])
        if size:
            crop_w, crop_h = int(size[0]), int(size[1])

        # 裁切回贴是「合成」动作：画布固定 RGB 三通道，alpha 只从 mask 输入取
        out = base[..., :3].clone()
        # 贴回原位（尺寸按 stitch 记录的裁切区域缩放）
        patch = crop[:, :, :, :3].permute(0, 3, 1, 2)
        patch = torch.nn.functional.interpolate(patch, size=(crop_h, crop_w), mode="bilinear", align_corners=False)
        patch = patch.permute(0, 2, 3, 1)

        ui = {}
        meta = self._save_temp_png(crop)
        if meta:
            # 前端「用 PhotoCraft 编辑」会优先拿这张真实裁切图当上层图层
            ui["photocraft_crop"] = [meta]

        x0 = max(0, crop_x)
        y0 = max(0, crop_y)
        x1 = min(base_w, crop_x + crop_w)
        y1 = min(base_h, crop_y + crop_h)
        if x1 <= x0 or y1 <= y0:
            mask_out = torch.zeros(base_h, base_w, dtype=torch.float32).unsqueeze(0)
            return {"ui": ui, "result": (out, mask_out)}

        patch = patch[:, y0 - crop_y : y1 - crop_y, x0 - crop_x : x1 - crop_x, :]

        crop_src_h, crop_src_w = int(crop.shape[1]), int(crop.shape[2])
        if stitch_mode == "crop_image":
            # 整块裁切图贴回：不看遮罩，只按裁切块自身的 alpha（没有 alpha 就整块不透明）
            if int(crop.shape[-1]) >= 4:
                alpha_full = crop[..., 3].float()
            else:
                alpha_full = torch.ones((crop.shape[0], crop_src_h, crop_src_w), dtype=torch.float32)
        elif isinstance(mask, torch.Tensor):
            # crop_mask：只贴遮罩内的部分，alpha 来自 mask
            alpha_full = mask if mask.ndim == 3 else mask[None,]
        else:
            alpha_full = torch.ones((crop.shape[0], crop_src_h, crop_src_w), dtype=torch.float32)

        # 统一按 stitch 记录的裁切尺寸缩放，再裁到画布内的窗口
        alpha = torch.nn.functional.interpolate(
            alpha_full.unsqueeze(1).float(), size=(crop_h, crop_w), mode="bilinear", align_corners=False
        )[0, 0]
        alpha = alpha[y0 - crop_y : y1 - crop_y, x0 - crop_x : x1 - crop_x].clamp(0.0, 1.0).unsqueeze(-1)

        # crop_image 用羽化边（等价 Image_solo_stitch 的 create_feather_mask）：
        # 在裁切尺寸上生成四周衰减的 alpha，再跟着窗口一起裁
        if stitch_mode == "crop_image" and int(feather or 0) > 0:
            feather_full = self._feather_mask(crop_h, crop_w, feather)
            feather_win = feather_full[y0 - crop_y : y1 - crop_y, x0 - crop_x : x1 - crop_x]
            alpha = alpha * feather_win.unsqueeze(-1)

        region = out[:, y0:y1, x0:x1, :3]
        out[:, y0:y1, x0:x1, :3] = region * (1 - alpha) + patch * alpha

        mask_out = torch.zeros(base_h, base_w, dtype=torch.float32)
        mask_out[y0:y1, x0:x1] = 1.0 - alpha[..., 0]
        return {"ui": ui, "result": (out, mask_out.unsqueeze(0))}


class PhotoCraftMask:
    """单图 + 单遮罩：遮罩作为「alpha 遮罩图层」叠在原图上层，在 PhotoCraft 里编辑后回写。

    图层栈 = 底图 + 上层（RGB 取自原图、alpha 取自遮罩：alpha 大 = 遮罩内可见），
    所以被遮罩盖住的区域是活动的，露出来的底图就是原图，看起来永远不透明。
    导出后：mask = 导出图的 alpha；image = 导出图按 alpha 叠回底图（不留透明黑洞）。
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
                "mask": ("MASK",),
            },
            "optional": {
                # 编辑器回传的结果文件名（由前端写入），空表示还没编辑过
                "mask_out": ("STRING", {"default": "", "multiline": False}),
            },
        }

    RETURN_TYPES = ("IMAGE", "MASK")
    RETURN_NAMES = ("image", "mask")
    FUNCTION = "mask"
    CATEGORY = "Apt_Preset/PhotoCraft"

    @classmethod
    def IS_CHANGED(cls, mask_out="", **kwargs):
        parts = [str(mask_out)]
        # 遮罩节点的结果文件名是固定的（photocraft_doc_<id>.psd），只看名字会把「改了遮罩」当成没变；
        # 这里把文件的修改时间/大小也算进指纹。
        if mask_out:
            try:
                path = folder_paths.get_annotated_filepath(mask_out)
                if not os.path.exists(path):
                    path = os.path.join(folder_paths.get_input_directory(), mask_out)
                if os.path.exists(path):
                    stat = os.stat(path)
                    parts.append(f"{stat.st_mtime_ns}:{stat.st_size}")
            except Exception:
                pass
        for key, value in sorted(kwargs.items()):
            if isinstance(value, torch.Tensor):
                parts.append(f"{key}:{tuple(value.shape)}:{float(value.float().mean()):.6f}")
        return "|".join(parts)

    @staticmethod
    def _save_mask_png(mask_np, prefix="photocraft_mask"):
        """遮罩存成灰度 PNG 放 temp，前端点「编辑遮罩」时取这张当画布。"""
        try:
            import time

            name = f"{prefix}_{int(time.time() * 1000)}.png"
            arr = (mask_np * 255.0).clip(0, 255).astype(np.uint8)
            Image.fromarray(arr if arr.ndim == 2 else arr[..., 0]).save(
                os.path.join(folder_paths.get_temp_directory(), name)
            )
            return {"filename": name, "subfolder": "", "type": "temp"}
        except Exception:
            return None

    @staticmethod
    def _normalize_mask(mask, height, width):
        """统一成 (h, w) 的 float 数组：压掉 batch、必要时缩放到图片尺寸。"""
        if isinstance(mask, torch.Tensor):
            arr = mask.detach().cpu().float()
            while arr.ndim > 2:
                arr = arr[0]
            arr = arr.numpy()
        else:
            arr = np.asarray(mask, dtype=np.float32)
            while arr.ndim > 2:
                arr = arr[0]
        if arr.shape[:2] != (height, width):
            arr = (
                np.asarray(
                    Image.fromarray((arr * 255.0).clip(0, 255).astype(np.uint8)).resize(
                        (width, height), Image.BILINEAR
                    ),
                    dtype=np.float32,
                )
                / 255.0
            )
        return np.clip(arr, 0.0, 1.0).astype(np.float32)

    @staticmethod
    def _read_layer_alpha(path, height, width):
        """分层文档（PSD/PSB）：抠出「遮罩图层」的 RGB 和 alpha，尺寸统一到图片尺寸。

        编辑器里遮罩图层叫 photocraft_masklayer_*；找不到就退到最上面一层非 Background。
        """
        from psd_tools import PSDImage

        psd = PSDImage.open(path)
        layers = [layer for layer in psd if layer.visible]
        target = next((l for l in layers if str(l.name).startswith("photocraft_masklayer")), None)
        if target is None:
            candidates = [l for l in layers if str(l.name).lower() != "background"]
            target = candidates[-1] if candidates else (layers[-1] if layers else None)
        if target is None:
            return None, None

        layer = target.topil()
        if layer is None:
            return None, None
        canvas = Image.new("RGBA", psd.size, (0, 0, 0, 0))
        canvas.paste(layer.convert("RGBA"), (int(target.left), int(target.top)))
        if canvas.size != (width, height):
            canvas = canvas.resize((width, height), Image.BILINEAR)
        rgba = np.asarray(canvas, dtype=np.float32) / 255.0
        return rgba[..., :3], rgba[..., 3]

    def mask(self, image, mask, mask_out=""):
        img = image if image.ndim == 4 else image[None,]
        img = img[..., :3]
        height, width = int(img.shape[1]), int(img.shape[2])
        base = img[0].detach().cpu().numpy().astype(np.float32)  # (h, w, 3)

        edited_image = None
        edited_mask = None
        if mask_out:
            path = folder_paths.get_annotated_filepath(mask_out)
            if not os.path.exists(path):
                path = os.path.join(folder_paths.get_input_directory(), mask_out)
            if os.path.exists(path):
                try:
                    if os.path.splitext(path)[1].lower() in (".psd", ".psb"):
                        # 分层文档：alpha 藏在图层里，PNG 扁平导出会把 alpha 拍平丢掉
                        rgb, alpha = self._read_layer_alpha(path, height, width)
                        if alpha is not None:
                            # 编辑器里上层就是一张 Alpha 遮罩层：alpha 直接等于遮罩值
                            # （遮罩内不透明、遮罩外透明），所以遮罩 = 图层 alpha；
                            # 图片直通底图（这层只是遮罩的可视化，不携带画面）
                            edited_image = base
                            edited_mask = np.clip(alpha, 0.0, 1.0)
                    else:
                        # PNG 只有「带 alpha 的图层图」才能当遮罩用。扁平导出（无 alpha）里是画面像素，
                        # 拿它的亮度当遮罩会得到一张灰度原图（典型表现：节点预览变成灰白老虎）。
                        # 这种文件一律忽略，回退到输入的 mask。
                        with Image.open(path) as im:
                            if "A" in im.getbands():
                                layer = im.convert("RGBA")
                                if layer.size != (width, height):
                                    layer = layer.resize((width, height), Image.BILINEAR)
                                rgba = np.asarray(layer, dtype=np.float32) / 255.0
                                edited_image = base
                                edited_mask = np.clip(rgba[..., 3], 0.0, 1.0)
                except Exception:
                    edited_image = None
                    edited_mask = None

        if edited_mask is None:
            edited_mask = self._normalize_mask(mask, height, width)
        if edited_image is None:
            edited_image = base

        out_image = torch.from_numpy(np.ascontiguousarray(edited_image)).float()[None,]
        out_mask = torch.from_numpy(edited_mask[None,]).float()

        ui = {}
        meta = self._save_mask_png(edited_mask)
        if meta:
            # 前端「编辑遮罩」拿这张灰度图算 alpha 图层（白 = 遮罩内）
            ui["photocraft_mask"] = [meta]

        return {"ui": ui, "result": (out_image, out_mask)}




FLATTEN_PREFIX = "photocraft_flat_"


def _photocraft_source_path(filename, type_="input", subfolder=""):
    name = os.path.basename(str(filename).replace("\\", "/"))
    # ComfyUI 的“带标注”路径：name.png [input] / name.png [output] / name.png [temp]
    marker = re.search(r"\s*\[(input|output|temp)\]\s*$", name, re.IGNORECASE)
    if marker:
        type_ = type_ or marker.group(1).lower()
        name = name[: marker.start()].strip()
    sub = str(subfolder or "").replace("\\", "/").strip("/")
    for base in (
        folder_paths.get_directory_by_type(type_ or "input"),
        folder_paths.get_input_directory(),
        folder_paths.get_temp_directory(),
        folder_paths.get_output_directory(),
    ):
        if not base:
            continue
        path = os.path.join(base, sub, name)
        if os.path.isfile(path):
            return path

    # 兜底：subfolder/type 对不上时（不同节点的标注方式不一样），按文件名在三个目录里浅层搜一遍。
    for base in (
        folder_paths.get_input_directory(),
        folder_paths.get_temp_directory(),
        folder_paths.get_output_directory(),
    ):
        if not base or not os.path.isdir(base):
            continue
        for root, _dirs, files in os.walk(base):
            if os.path.relpath(root, base).count(os.sep) > 3:
                _dirs[:] = []
                continue
            if name in files:
                return os.path.join(root, name)
    return None


def _photocraft_flatten_png(src_path, out_name, color=None):
    """把带 alpha 的图垫成不透明 RGB：color 为空时透明区写成黑（老行为），
    给颜色名（white/black/…）或 #rrggbb 时按该色垫底。本来就不透明则返回 None（不复制）。"""
    with Image.open(src_path) as image:
        image = ImageOps.exif_transpose(image)
        has_alpha = "A" in image.getbands() or (image.mode == "P" and "transparency" in image.info)
        if not has_alpha:
            return None
        rgba = image.convert("RGBA")

    rgb = rgba.convert("RGB")
    if color:
        patch = Image.new("RGB", rgba.size, _photocraft_color_tuple(color))
        patch.paste(rgb, (0, 0), rgba.getchannel("A"))
        rgb = patch

    target = os.path.join(folder_paths.get_input_directory(), os.path.basename(out_name))
    rgb.save(target, "PNG")
    return os.path.basename(out_name)


def _photocraft_color_tuple(color):
    """把背景色名或 #rrggbb 转成 PIL 用的 (r,g,b)。"""
    named = {
        "white": (255, 255, 255),
        "black": (0, 0, 0),
        "red": (255, 0, 0),
        "green": (0, 255, 0),
        "blue": (0, 0, 255),
        "gray": (128, 128, 128),
        "grey": (128, 128, 128),
    }
    key = str(color).strip().lower()
    if key in named:
        return named[key]
    if re.fullmatch(r"#?[0-9a-f]{6}", key):
        key = key.lstrip("#")
        return (int(key[0:2], 16), int(key[2:4], 16), int(key[4:6], 16))
    return (0, 0, 0)


def _photocraft_mask_preview(src_path, out_name, invert=False):
    """把编辑结果里的遮罩渲成灰度图（白 = 遮罩内），给节点当预览缩略图。
    invert=True 时按 MASK 语义取反（1 - alpha），和节点 MASK 输出保持一致。"""
    ext = os.path.splitext(src_path)[1].lower()
    if ext in (".psd", ".psb"):
        from psd_tools import PSDImage

        psd = PSDImage.open(src_path)
        width, height = int(psd.size[0]), int(psd.size[1])
        _rgb, alpha = PhotoCraftMask._read_layer_alpha(src_path, height, width)
    else:
        with Image.open(src_path) as im:
            width, height = im.size
            layer = im.convert("RGBA")
        rgba = np.asarray(layer, dtype=np.float32) / 255.0
        alpha = rgba[..., 3] if "A" in layer.getbands() else None

    if alpha is None:
        raise ValueError("结果里没有 alpha，渲不出遮罩")
    mask = np.clip(alpha, 0.0, 1.0)
    if invert:
        mask = 1.0 - mask
    gray = Image.fromarray((mask * 255.0).astype(np.uint8), mode="L")
    target = os.path.join(folder_paths.get_temp_directory(), os.path.basename(out_name))
    gray.save(target, "PNG")
    return os.path.basename(out_name)


def _photocraft_opaque_export(src_path, out_name, sources=None):
    """把 PhotoCraft 导出的 RGBA 做成不透明 PNG：
    透明区（alpha=0）在导出 PNG 里被压成黑色，直接当 IMAGE 用就是一块黑斑，
    看起来像把遮罩并进了图片。这里用上游原图（最先接的那张、尺寸一致）垫底，
    再把导出结果按 alpha 叠上去，透明区就还原成上游本来那块像素，整张图 alpha=255。

    返回 (output 目录文件名, input 目录文件名)；输入文件不存在上游可垫底时抛 ValueError。
    """
    with Image.open(src_path) as image:
        image = ImageOps.exif_transpose(image)
        exported = image.convert("RGBA")

    width, height = exported.size
    base = None
    for item in sources or []:
        if not isinstance(item, dict):
            continue
        path = _photocraft_source_path(item.get("filename"), item.get("type"), item.get("subfolder"))
        if not path:
            continue
        try:
            with Image.open(path) as im:
                im = ImageOps.exif_transpose(im)
                candidate = im.convert("RGB")
        except Exception:
            continue
        if candidate.size == (width, height):
            base = candidate
            break
        if base is None:
            base = candidate.resize((width, height), Image.LANCZOS)

    if base is None:
        raise ValueError("没有可用于垫底的上游图片（编辑器里没有原图层来源）")

    flat = base.copy()
    flat.paste(exported.convert("RGB"), (0, 0), exported.getchannel("A"))
    out_name = os.path.basename(out_name)

    # output = 给人和下游看的不透明结果；input = 原始导出（保留 alpha），
    # 节点的 MASK 输出就是从 input 这份的 alpha 算出来的，所以不能把它抹平。
    flat.save(os.path.join(folder_paths.get_output_directory(), out_name), "PNG")
    shutil.copyfile(src_path, os.path.join(folder_paths.get_input_directory(), out_name))
    return out_name, out_name


try:  # 没跑在 ComfyUI 服务里（单测/离线导入）就跳过路由注册
    from aiohttp import web
    from server import PromptServer

    @PromptServer.instance.routes.post("/photocraft/opaque")
    async def photocraft_opaque(request):
        """导出回传：把编辑器导出的 RGBA 合成成不透明 PNG，同时写 output（归档）和 input（节点引用）。"""
        try:
            data = await request.json()
        except Exception:
            data = {}
        staging = str(data.get("staging") or "")
        out = str(data.get("out") or "").replace("/", "_").replace("\\", "_")
        if not staging or not out:
            return web.json_response({"error": "staging / out 必填"}, status=400)

        src = _photocraft_source_path(staging, "input")
        if not src:
            return web.json_response({"error": f"找不到导出临时文件：{staging}"}, status=404)

        try:
            name, input_name = _photocraft_opaque_export(src, out, data.get("sources") or [])
        except Exception as e:
            return web.json_response({"error": f"合成不透明导出失败：{e}"}, status=500)
        finally:
            try:
                os.remove(src)
            except OSError:
                pass

        return web.json_response({"name": input_name, "subfolder": "", "type": "input", "output": name})


    @PromptServer.instance.routes.post("/photocraft/flatten")
    async def photocraft_flatten(request):
        try:
            data = await request.json()
        except Exception:
            data = {}
        filename = str(data.get("filename") or "")
        subfolder = str(data.get("subfolder") or "")
        out = str(data.get("out") or "").replace("/", "_").replace("\\", "_")
        if not filename or not out:
            return web.json_response({"error": "filename / out 必填"}, status=400)

        src = _photocraft_source_path(filename, data.get("type"), data.get("subfolder"))
        if not src:
            return web.json_response(
                {"error": f"找不到源文件：{filename}（subfolder={subfolder!r}，type={data.get('type')!r}）"},
                status=404,
            )

        try:
            name = _photocraft_flatten_png(src, out, data.get("color") or None)
        except Exception as e:
            return web.json_response({"error": f"垫底失败：{e}"}, status=500)

        # 本来就不透明：直接把原文件还给前端
        return web.json_response(
            {
                "name": name or os.path.basename(filename),
                "subfolder": "" if name else str(data.get("subfolder") or ""),
                "type": "input" if name else str(data.get("type") or "input"),
                "copied": bool(name),
            }
        )

    @PromptServer.instance.routes.post("/photocraft/maskpreview")
    async def photocraft_mask_preview_route(request):
        try:
            data = await request.json()
        except Exception:
            data = {}
        filename = str(data.get("filename") or "")
        out = str(data.get("out") or "photocraft_maskprev.png").replace("/", "_").replace("\\", "_")
        if not filename:
            return web.json_response({"error": "filename 必填"}, status=400)

        src = _photocraft_source_path(filename, data.get("type"), data.get("subfolder"))
        if not src:
            return web.json_response({"error": f"找不到结果文件：{filename}"}, status=404)

        try:
            name = _photocraft_mask_preview(src, out, bool(data.get("invert")))
        except Exception as e:
            return web.json_response({"error": f"生成遮罩预览失败：{e}"}, status=500)

        return web.json_response({"name": name, "subfolder": "", "type": "temp"})

except Exception:  # pragma: no cover
    pass
