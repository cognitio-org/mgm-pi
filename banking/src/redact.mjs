// Mask bank identifiers and JWTs before text is printed or returned to a model.
export function maskSensitive(text) {
  return String(text)
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[redacted-jwt]")
    .replace(/\b([A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){2,7}(?:\s?[A-Z0-9]{1,4})?)\b/g, (raw) => {
      const compact = raw.replace(/\s+/g, "");
      if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(compact) || compact.length > 34) return raw;
      return `${compact.slice(0, 2)}••${compact.slice(-4)}`;
    });
}

export function clip(text) {
  return maskSensitive(text).replace(/\s+/g, " ").slice(0, 300);
}
