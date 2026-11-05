export const MAX_EXAMPLE_SOURCE_BYTES = 20 * 1024 * 1024;
export const MAX_EXAMPLE_THUMBNAIL_BYTES = 512 * 1024;
export const EXAMPLE_THUMBNAIL_SIDE = 384;

export function normalizeExampleImageId(value) {
    return typeof value === "string" && /^[0-9a-f]{64}$/.test(value) ? value : null;
}

export function effectiveExampleImageId(item, library) {
    if (item?.random_favorite_category) return null;
    const favorite = Array.isArray(library?.cards)
        ? library.cards.find((card) => card.id === item?.favorite_id)
        : null;
    return normalizeExampleImageId(favorite ? favorite.example_image_id : item?.example_image_id);
}

export function exampleThumbnailSize(width, height) {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        throw new Error("The selected image could not be read.");
    }
    const scale = Math.min(1, EXAMPLE_THUMBNAIL_SIDE / Math.max(width, height));
    return {
        width: Math.max(1, Math.round(width * scale)),
        height: Math.max(1, Math.round(height * scale)),
    };
}

export async function createExampleThumbnail(file) {
    if (!file || !Number.isFinite(file.size) || file.size <= 0 || file.size > MAX_EXAMPLE_SOURCE_BYTES) {
        throw new Error("Choose an image no larger than 20 MiB.");
    }
    if (file.type && !file.type.startsWith("image/")) {
        throw new Error("Choose an image file.");
    }
    let bitmap;
    try {
        bitmap = await createImageBitmap(file);
        const size = exampleThumbnailSize(bitmap.width, bitmap.height);
        const canvas = document.createElement("canvas");
        canvas.width = size.width;
        canvas.height = size.height;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("The selected image could not be read.");
        context.drawImage(bitmap, 0, 0, size.width, size.height);
        for (const quality of [0.82, 0.68, 0.5]) {
            const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/webp", quality));
            if (blob?.type === "image/webp" && blob.size <= MAX_EXAMPLE_THUMBNAIL_BYTES) return blob;
        }
        throw new Error("The thumbnail could not be reduced below 512 KiB.");
    } catch (error) {
        if (error?.message?.startsWith("The ")) throw error;
        throw new Error("The selected image could not be read.", { cause: error });
    } finally {
        bitmap?.close?.();
    }
}
