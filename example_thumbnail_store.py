"""Per-user, content-addressed cache of prompt-card thumbnail pixels."""

from __future__ import annotations

from hashlib import sha256
from io import BytesIO
import os
from pathlib import Path
import re
import tempfile
from threading import RLock

from PIL import Image, UnidentifiedImageError


MAX_THUMBNAIL_BYTES = 512 * 1024
MAX_CACHE_BYTES = 256 * 1024 * 1024
MAX_THUMBNAIL_SIDE = 384
IMAGE_ID_RE = re.compile(r"^[0-9a-f]{64}$")


class ThumbnailValidationError(ValueError):
    pass


class ThumbnailCapacityError(ValueError):
    pass


class ExampleThumbnailStore:
    def __init__(self, directory):
        self.directory = Path(directory)
        self._lock = RLock()

    def save(self, raw):
        if not isinstance(raw, bytes) or not raw or len(raw) > MAX_THUMBNAIL_BYTES:
            raise ThumbnailValidationError("thumbnail must be a non-empty WebP up to 512 KiB")
        try:
            with Image.open(BytesIO(raw)) as image:
                if image.format != "WEBP" or getattr(image, "n_frames", 1) != 1:
                    raise ThumbnailValidationError("thumbnail must be a still WebP image")
                width, height = image.size
                if not (1 <= width <= MAX_THUMBNAIL_SIDE and 1 <= height <= MAX_THUMBNAIL_SIDE):
                    raise ThumbnailValidationError("thumbnail dimensions must not exceed 384 pixels")
                image.load()
                pixels = image.convert("RGBA" if "A" in image.getbands() else "RGB")
                thumbnail = b""
                for quality in (82, 68, 50):
                    buffer = BytesIO()
                    pixels.save(buffer, format="WEBP", quality=quality, method=4)
                    thumbnail = buffer.getvalue()
                    if len(thumbnail) <= MAX_THUMBNAIL_BYTES:
                        break
        except (UnidentifiedImageError, OSError, ValueError) as error:
            if isinstance(error, ThumbnailValidationError):
                raise
            raise ThumbnailValidationError("thumbnail is not a valid WebP image") from error
        if len(thumbnail) > MAX_THUMBNAIL_BYTES:
            raise ThumbnailValidationError("thumbnail exceeds 512 KiB after validation")

        image_id = sha256(thumbnail).hexdigest()
        target = self.directory / f"{image_id}.webp"
        with self._lock:
            if target.is_file():
                return image_id
            used = sum(path.stat().st_size for path in self.directory.glob("*.webp")) if self.directory.is_dir() else 0
            if used + len(thumbnail) > MAX_CACHE_BYTES:
                raise ThumbnailCapacityError("example thumbnail cache is full (256 MiB)")
            self.directory.mkdir(parents=True, exist_ok=True)
            handle, temporary = tempfile.mkstemp(prefix=".thumbnail-", suffix=".tmp", dir=self.directory)
            try:
                with os.fdopen(handle, "wb") as stream:
                    stream.write(thumbnail)
                    stream.flush()
                    os.fsync(stream.fileno())
                os.replace(temporary, target)
            finally:
                if os.path.exists(temporary):
                    os.unlink(temporary)
        return image_id

    def path_for(self, image_id):
        if not isinstance(image_id, str) or not IMAGE_ID_RE.fullmatch(image_id):
            return None
        path = self.directory / f"{image_id}.webp"
        return path if path.is_file() else None
