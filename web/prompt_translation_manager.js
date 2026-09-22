export const TRANSLATION_STATUS_POLL_MS = 500;
export const TRANSLATION_UPDATE_TIMEOUT_MS = 5 * 60 * 1000;

export function translationManagerState(status = {}) {
    const available = Boolean(status.available);
    const updating = Boolean(status.updating);
    const error = String(status.error || "").trim();
    const summary = updating ? "updating" : error ? (available ? "warning" : "failed")
        : available ? "ready" : "not-installed";
    const count = Math.max(0, Math.floor(Number(status.total_count) || 0));
    return {
        available, updating, ready: available, error, summary,
        tone: { updating: "info", warning: "warning", failed: "error", ready: "success", "not-installed": "neutral" }[summary],
        importing: Boolean(status.importing),
        action: status.sources?.downloaded?.available ? "update" : "download",
        rowCount: count,
        translatedTagCount: count,
        coveragePercent: available ? 100 : 0,
        selectedSource: status.selected_source === "local" ? "local" : "downloaded",
        localPath: String(status.local_path || ""),
        fileSha256: String(status.file_sha256 || ""),
        fileModifiedAt: String(status.file_modified_at || ""),
        sourcePage: String(status.source_page || ""),
        version: String(status.version || ""),
        lastCheckedAt: String(status.last_checked_at || ""),
        lastUpdatedAt: String(status.last_updated_at || ""),
    };
}

export function shortBlobSha(value) {
    const sha = String(value || "").trim();
    return sha.length > 12 ? sha.slice(0, 12) : sha;
}
