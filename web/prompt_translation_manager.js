export const TRANSLATION_STATUS_POLL_MS = 500;
export const TRANSLATION_UPDATE_TIMEOUT_MS = 5 * 60 * 1000;

function nonNegativeInteger(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function percentage(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return 0;
    return Math.max(0, Math.min(100, number));
}

export function translationManagerState(status = {}) {
    const available = Boolean(status?.available);
    const updating = Boolean(status?.updating);
    const ready = Boolean(status?.ready);
    const error = String(status?.error || "").trim();
    const supplementError = String(status?.supplement_error || "").trim();
    const supplementLocalError = String(
        status?.supplement_local_error || "",
    ).trim();
    const supplementLicenseStatus = String(
        status?.supplement_license_status || "",
    ).trim().toLowerCase();

    let tone = "neutral";
    let summary = "not-installed";
    if (updating) {
        tone = "info";
        summary = "updating";
    } else if (!available && error) {
        tone = "error";
        summary = "failed";
    } else if (error || supplementError || supplementLocalError || (available && !ready)) {
        tone = "warning";
        summary = "warning";
    } else if (ready) {
        tone = "success";
        summary = "ready";
    }

    let supplementTone = "neutral";
    let supplementState = "disabled";
    if (supplementLicenseStatus === "pending") {
        supplementTone = "warning";
        supplementState = "license-pending";
    } else if ((supplementError || supplementLocalError) && !status?.supplement_available) {
        supplementTone = "warning";
        supplementState = "failed";
    } else if (status?.supplement_available) {
        supplementTone = supplementLocalError || supplementLicenseStatus === "user-directed"
            ? "warning"
            : "success";
        supplementState = status?.supplement_origin === "local"
            ? "available-local-file"
            : (supplementLicenseStatus === "user-directed"
                ? "available-local-use"
                : "available");
    } else if (status?.supplement_enabled) {
        supplementTone = "neutral";
        supplementState = supplementLicenseStatus === "user-directed"
            ? "not-installed-local-use"
            : "not-installed";
    }

    return {
        available,
        updating,
        ready,
        error,
        supplementError,
        supplementLocalError,
        tone,
        summary,
        action: available ? "update" : "download",
        rowCount: nonNegativeInteger(status?.row_count),
        primaryTranslationAvailable: Boolean(status?.primary_translation_available),
        primaryTranslationCount: nonNegativeInteger(status?.primary_translation_count),
        translatedTagCount: nonNegativeInteger(status?.translated_tag_count),
        coveragePercent: percentage(status?.translation_coverage_percent),
        supplementEnabled: Boolean(status?.supplement_enabled),
        supplementAvailable: Boolean(status?.supplement_available),
        supplementTranslationCount: nonNegativeInteger(
            status?.supplement_translation_count,
        ),
        supplementLicenseStatus,
        supplementSourcePage: String(status?.supplement_source_page || "").trim(),
        supplementBlobSha: String(status?.supplement_blob_sha || "").trim(),
        supplementOrigin: ["local", "downloaded"].includes(status?.supplement_origin)
            ? status.supplement_origin
            : "",
        supplementDropInPath: String(status?.supplement_drop_in_path || "").trim(),
        supplementFileSha256: String(status?.supplement_file_sha256 || "").trim(),
        supplementRowCount: nonNegativeInteger(status?.supplement_row_count),
        supplementFileModifiedAt: String(
            status?.supplement_file_modified_at || "",
        ).trim(),
        supplementImporting: Boolean(status?.supplement_importing),
        supplementLastUpdatedAt: String(
            status?.supplement_last_updated_at || "",
        ).trim(),
        supplementTone,
        supplementState,
        version: String(status?.version || "").trim(),
        lastCheckedAt: String(status?.last_checked_at || "").trim(),
        lastUpdatedAt: String(status?.last_updated_at || "").trim(),
    };
}

export function shortBlobSha(value) {
    const sha = String(value || "").trim();
    return sha.length > 12 ? sha.slice(0, 12) : sha;
}
