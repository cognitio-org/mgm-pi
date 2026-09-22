import { DeviceNotPresentIcon } from "./ErrorIcons.tsx";

interface Props {
  /** Plain-language reason: "the local provider is down", "you're offline", etc. */
  reason: string;
  /** "inline" sits in a table cell/status line (ProvidersPage, the session model-unreachable
   * banner); "banner" is a full-width dismissable strip (the offline banner). */
  variant?: "inline" | "banner";
}

/** "?DEVICE NOT PRESENT ERROR" -- a provider that's down, a session whose model is unreachable, or
 * the browser itself being offline (docs/reports/mobile-desk.md). */
export function DeviceNotPresent({ reason, variant = "inline" }: Props) {
  return (
    <span className={`device-not-present device-not-present-${variant}`} role="alert">
      <DeviceNotPresentIcon size={variant === "banner" ? 20 : 14} />
      <span>
        <strong>?DEVICE NOT PRESENT ERROR</strong> &mdash; {reason}
      </span>
    </span>
  );
}
