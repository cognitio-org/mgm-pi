import { Link } from "react-router-dom";
import { vocabulary } from "../lib/vocabulary.ts";
import { FileNotFoundIcon } from "./ErrorIcons.tsx";

interface Props {
  /** What wasn't found, in plain language ("This page", "This floppy"). */
  subject: string;
}

/** "?FILE NOT FOUND ERROR" -- the 404 route and any unknown session/guru id (docs/reports/
 * mobile-desk.md). A real heading (not just styled text) and role="alert" so assistive tech
 * announces it the moment it renders, plus a link back to the desk. */
export function NotFoundError({ subject }: Props) {
  return (
    <div className="retro-error-page" role="alert">
      <FileNotFoundIcon size={40} />
      <h2 className="retro-error-headline">?FILE NOT FOUND ERROR</h2>
      <p>{subject} could not be found.</p>
      <p>
        <Link to="/">Back to the {vocabulary.desk.one}</Link>
      </p>
    </div>
  );
}
