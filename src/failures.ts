const stableFailures = new Set([
  "scrape_content_unavailable", "scrape_access_restricted", "scrape_rate_limited", "scrape_no_public_evidence",
  "scrape_primary_timeout", "scrape_primary_network_error", "scrape_embed_timeout", "scrape_embed_network_error",
  "scrape_browser_challenge", "scrape_browser_failed", "scrape_unsafe_media_url", "scrape_unsafe_media_redirect",
  "scrape_unsafe_image_url", "scrape_unsafe_image_redirect", "media_too_large", "media_too_long", "media_invalid_type",
  "media_probe_failed", "media_extraction_failed", "image_invalid_type", "image_too_large", "low_confidence", "catalog_no_match",
]);

export function normalizePipelineFailure(error: unknown) {
  const code = error instanceof Error ? error.message : "pipeline_error";
  if (stableFailures.has(code) || /^(?:scrape|media|image)_(?:primary|embed)?_?http_\d{3}$/.test(code)) return code;
  return "pipeline_error";
}

export function isRecoverableFailure(code: string | null | undefined) {
  if (!code) return false;
  return code === "scrape_rate_limited" || code.endsWith("_timeout") || code.endsWith("_network_error") ||
    code === "scrape_browser_failed" || code === "media_probe_failed" || code === "media_extraction_failed" || code === "pipeline_error";
}
