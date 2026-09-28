"""Isolated frontend fixture; no ComfyUI installation, database or user data."""
import json
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parents[1]


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def respond(self, payload, content_type="application/json"):
        data = (json.dumps(payload) if content_type == "application/json" else payload).encode()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/scripts/app.js":
            return self.respond("export const app = globalThis.fixtureApp;", "text/javascript")
        if path == "/scripts/api.js":
            return self.respond("export const api = globalThis.fixtureApi;", "text/javascript")
        if path == "/extensions":
            return self.respond([])
        if path == "/prompt-weaver/prompt-card-library":
            if "random_fixture" not in parse_qs(urlparse(self.path).query):
                return self.respond({"format_version": 1, "revision": 0, "categories": [], "cards": []})
            return self.respond({"format_version": 1, "revision": 1, "categories": [
                {"id": "11111111-1111-4111-8111-111111111111", "parent_id": None,
                 "name": "People", "created_at": "2026-01-01T00:00:00Z", "updated_at": "2026-01-01T00:00:00Z"},
                {"id": "22222222-2222-4222-8222-222222222222", "parent_id": "11111111-1111-4111-8111-111111111111",
                 "name": "Common", "created_at": "2026-01-01T00:00:00Z", "updated_at": "2026-01-01T00:00:00Z"},
            ], "cards": [
                {"id": "33333333-3333-4333-8333-333333333333", "category_id": "22222222-2222-4222-8222-222222222222",
                 "title": "Red", "prompt": "red hair", "created_at": "2026-01-01T00:00:00Z", "updated_at": "2026-01-01T00:00:00Z"},
                {"id": "44444444-4444-4444-8444-444444444444", "category_id": "22222222-2222-4222-8222-222222222222",
                 "title": "Blue", "prompt": "blue hair", "created_at": "2026-01-01T00:00:00Z", "updated_at": "2026-01-01T00:00:00Z"},
            ]})
        if path == "/prompt-weaver/prompt-grid-archives":
            return self.respond({"format_version": 1, "revision": 0, "archives": [], "selected_archive_id": None})
        if path == "/prompt-weaver/tag-autocomplete/status":
            return self.respond({"available": True, "needs_download": False, "version": "isolated-test"})
        if path == "/prompt-weaver/tag-autocomplete/search":
            query = parse_qs(urlparse(self.path).query).get("q", [""])[0].lower()
            rows = [
                {"tag": "red_pantyhose", "insert_text": "red pantyhose", "translation": "红色连裤袜", "category": 0, "post_count": 2000},
                {"tag": "black_pantyhose", "insert_text": "black pantyhose", "translation": "黑色连裤袜", "category": 0, "post_count": 3000},
            ]
            return self.respond({"results": [row for row in rows if query in row["tag"] or query in row["translation"]]})
        if path.startswith("/prompt-weaver/tag-autocomplete"):
            return self.respond({"available": False, "results": []})
        return super().do_GET()


if __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1]) if len(sys.argv) > 1 else 8776), Handler)
    print(f"http://127.0.0.1:{server.server_port}/tests/workflow_variables_browser.html", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
