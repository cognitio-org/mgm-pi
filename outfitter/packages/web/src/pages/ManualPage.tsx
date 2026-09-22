// /manual -- the Manual: the self-playing tour animation, then the glossary (table on desktop,
// cards on mobile), "how a typical task goes," and the retro error-message table. See
// docs/design/README.md for the theme this matches and docs/reports/manual-tour.md for how this
// page and its recording script were built.
import { useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { TourAnimation } from "../components/tour/TourAnimation.tsx";
import { TourOffer } from "../components/tour/TourOffer.tsx";
import { ERROR_MESSAGES, GLOSSARY_TERMS, TYPICAL_TASK_STEPS } from "../lib/glossary.ts";

/** Supports the record-tour.mjs script's /manual?autoplay=1&chrome=0: autoplay starts the tour
 * immediately, chrome=0 hides everything but the monitor (via a body class -- see tour.css) so the
 * capture is just the animation and its caption. Neither param has any effect for a regular
 * visitor unless they type it themselves. */
function useRecordingParams() {
  const [params] = useSearchParams();
  const autoplay = params.get("autoplay") === "1";
  const chromeOff = params.get("chrome") === "0";

  useEffect(() => {
    if (!chromeOff) return undefined;
    document.body.classList.add("tour-chrome-off");
    return () => document.body.classList.remove("tour-chrome-off");
  }, [chromeOff]);

  return { autoplay };
}

export function ManualPage() {
  const { autoplay } = useRecordingParams();

  return (
    <div className="manual-page">
      <TourOffer />

      <section className="tour-section">
        <TourAnimation autoplay={autoplay} />
      </section>

      <section aria-labelledby="glossary-heading">
        <div className="panel">
          <h2 className="panel-title" id="glossary-heading">
            <span className="panel-label">GLOSSARY</span>
          </h2>
          <div className="panel-body">
            <div className="table-scroll manual-glossary-table">
              <table className="data-table">
                <thead>
                  <tr>
                    <th aria-hidden="true"></th>
                    <th>Label</th>
                    <th>Plain meaning</th>
                    <th>Code name</th>
                  </tr>
                </thead>
                <tbody>
                  {GLOSSARY_TERMS.map((term) => (
                    <tr key={term.id} id={`glossary-${term.id}`}>
                      <td aria-hidden="true">{term.glyph}</td>
                      <td>{term.linkTo ? <a href={term.linkTo}>{term.label}</a> : term.label}</td>
                      <td>{term.meaning}</td>
                      <td>
                        <code>{term.codeName}</code>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <ul className="manual-glossary-cards">
              {GLOSSARY_TERMS.map((term) => (
                <li key={term.id} className="manual-glossary-card" id={`glossary-card-${term.id}`}>
                  <div className="manual-glossary-card-head">
                    <span aria-hidden="true">{term.glyph}</span>
                    <strong>{term.linkTo ? <a href={term.linkTo}>{term.label}</a> : term.label}</strong>
                  </div>
                  <p>{term.meaning}</p>
                  <p className="manual-glossary-card-code">
                    <code>{term.codeName}</code>
                  </p>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      <section aria-labelledby="task-heading">
        <div className="panel">
          <h2 className="panel-title" id="task-heading">
            <span className="panel-label">HOW A TYPICAL TASK GOES</span>
          </h2>
          <div className="panel-body">
            <ol className="manual-steps">
              {TYPICAL_TASK_STEPS.map((step, i) => (
                <li key={step.id}>
                  <span className="manual-steps-index" aria-hidden="true">
                    {i + 1}
                  </span>
                  <div>
                    <strong>{step.title}</strong>
                    <p>{step.detail}</p>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </div>
      </section>

      <section aria-labelledby="errors-heading">
        <div className="panel">
          <h2 className="panel-title" id="errors-heading">
            <span className="panel-label">ERROR MESSAGES</span>
          </h2>
          <div className="panel-body">
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Message</th>
                    <th>What it means</th>
                  </tr>
                </thead>
                <tbody>
                  {ERROR_MESSAGES.map((err) => (
                    <tr key={err.id}>
                      <td>
                        <code>{err.message}</code>
                      </td>
                      <td>{err.meaning}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
