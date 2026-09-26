"""Isolated frontend fixture; no ComfyUI installation, database or user data."""
import json
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
            return self.respond({"format_version": 1, "revision": 0, "categories": [], "cards": []})
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
    server = ThreadingHTTPServer(("127.0.0.1", 8776), Handler)
    print("http://127.0.0.1:8776/tests/workflow_variables_browser.html", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
