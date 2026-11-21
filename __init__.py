from .nodes import PhotoCraftCropStitch, PhotoCraftImageCombine, PhotoCraftLoadImage, PhotoCraftMask


NODE_CLASS_MAPPINGS = {
    "photoCraft_load_image": PhotoCraftLoadImage,
    "photoCraft_image_combine": PhotoCraftImageCombine,
    "photoCraft_crop_stitch": PhotoCraftCropStitch,
    #"photoCraft_mask": PhotoCraftMask,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "photoCraft_load_image": "photoCraft_load_image",
    "photoCraft_image_combine": "photoCraft_image_combine",
    "photoCraft_crop_stitch": "photoCraft_crop_stitch",
    #"photoCraft_mask": "photoCraft_mask",
}

WEB_DIRECTORY = "./web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
