import { useState } from "react";
import { createPortal } from "react-dom";
import { imageSrc, type UserImage } from "../lib/entry-view.ts";
import { ImageViewer } from "./ImageViewer.tsx";

export function UserAttachments({ images }: { images: UserImage[] }) {
  const [open, setOpen] = useState<number | null>(null);
  if (images.length === 0) return null;
  const current = open !== null ? images[open] : undefined;
  return (
    <div className="user-attachments">
      {images.map((image, i) => (
        <button key={i} type="button" className="user-attachment" onClick={() => setOpen(i)}>
          <img src={imageSrc(image)} alt={`Attached image ${i + 1}`} />
        </button>
      ))}
      {current
        ? createPortal(
            <ImageViewer src={imageSrc(current)} alt={`Attached image ${(open ?? 0) + 1}`} onClose={() => setOpen(null)} />,
            document.body,
          )
        : null}
    </div>
  );
}
