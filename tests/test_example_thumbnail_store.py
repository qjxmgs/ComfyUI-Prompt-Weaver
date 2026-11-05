from io import BytesIO
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

from PIL import Image


PLUGIN_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PLUGIN_ROOT))
import example_thumbnail_store as thumbnails  # noqa: E402


def webp(width=32, height=24, color="red"):
    output = BytesIO()
    Image.new("RGB", (width, height), color).save(output, "WEBP")
    return output.getvalue()


class ExampleThumbnailStoreTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.store = thumbnails.ExampleThumbnailStore(Path(self.temporary.name) / "cache")

    def tearDown(self):
        self.temporary.cleanup()

    def test_validated_thumbnail_is_deduplicated_and_addressed_by_hash(self):
        source = webp()
        image_id = self.store.save(source)
        self.assertEqual(len(image_id), 64)
        self.assertEqual(self.store.save(source), image_id)
        self.assertEqual(len(list(self.store.directory.glob("*.webp"))), 1)
        with Image.open(self.store.path_for(image_id)) as image:
            self.assertEqual(image.format, "WEBP")
            self.assertEqual(image.size, (32, 24))
        self.assertIsNone(self.store.path_for("../outside"))
        self.assertIsNone(self.store.path_for("A" * 64))

    def test_rejects_non_webp_oversized_and_corrupt_images_without_writing(self):
        png = BytesIO()
        Image.new("RGB", (20, 20), "blue").save(png, "PNG")
        for value in (png.getvalue(), b"broken", webp(385, 20), b"x" * (thumbnails.MAX_THUMBNAIL_BYTES + 1)):
            with self.subTest(length=len(value)), self.assertRaises(thumbnails.ThumbnailValidationError):
                self.store.save(value)
        self.assertFalse(self.store.directory.exists())

    def test_quota_failure_keeps_existing_cache_unchanged(self):
        first_id = self.store.save(webp(color="red"))
        first_path = self.store.path_for(first_id)
        with mock.patch.object(thumbnails, "MAX_CACHE_BYTES", first_path.stat().st_size):
            self.assertEqual(self.store.save(webp(color="red")), first_id)
            with self.assertRaises(thumbnails.ThumbnailCapacityError):
                self.store.save(webp(color="blue"))
        self.assertEqual(len(list(self.store.directory.glob("*.webp"))), 1)


if __name__ == "__main__":
    unittest.main()
