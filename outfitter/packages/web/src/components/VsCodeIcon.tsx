/**
 * A VS Code-shaped mark for the browser IDE's chips (#273): the blue ribbon folding back on a panel.
 * Drawn here, inline, so it needs no asset and follows the chip's size. Decorative: the chip's text
 * says what it is.
 */
export function VsCodeIcon({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg
      className={className ? `vscode-icon ${className}` : "vscode-icon"}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
    >
      {/* the panel on the right */}
      <path d="M17.2 1.6 22.4 4.1V19.9L17.2 22.4Z" fill="#0065A9" />
      {/* the ribbon: in from the top right, a fold at the left, out to the bottom right */}
      <path d="M17.2 1.6 7.9 10.4 3.6 7.1 1.6 8.1V15.9L3.6 16.9 7.9 13.6 17.2 22.4V16.9L10.4 12 17.2 7.1Z" fill="#007ACC" />
      {/* the fold's light edge */}
      <path d="M3.6 7.1 1.6 8.1V15.9L3.6 16.9 7.9 13.6 5 12l2.9-1.6Z" fill="#1F9CF0" />
    </svg>
  );
}
