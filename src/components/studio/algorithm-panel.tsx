import type {
  AlgorithmExplanation,
  HelpingFactor,
  HurtingFactor,
  SkippedFactor,
} from '@/lib/studio/explain';

/**
 * Spec 7.4 — the honest algorithm panel.
 *
 * Presentational only: it renders an AlgorithmExplanation and fetches nothing.
 * All of the judgement lives in explain.ts, which is separately tested.
 *
 * TWO RULES GOVERN EVERY LINE BELOW.
 *
 * Never hide a penalty. If the feed is holding a video back, this says so, in
 * those words, with the number. The alternative is a seller who believes they
 * have been shadowbanned — and they will be right that something happened and
 * wrong about what, which is the worst combination available.
 *
 * Never let it read as a scolding. Every negative arrives with its lever
 * attached. "31% skip rate" is an accusation; "31% skip rate — the first frame
 * is your biggest lever" is coaching. The type system already guarantees the
 * lever exists (HurtingFactor.lever is required), so this file's job is to make
 * sure it is always actually SHOWN, right next to the number it softens, rather
 * than parked somewhere the eye skips.
 *
 * One thing this component must never render: `contribution`. It is a raw score
 * weight used for ordering. Printing "commerce component 0.326" at a seller is
 * precisely the language the panel exists to replace.
 *
 * NOT MOUNTED YET, DELIBERATELY.
 *
 * explainVideo() needs `score` and `percentilePct`, and both come from the
 * ranker in src/lib/scoring/ — which is itself unwired from the live feed on
 * purpose, because the spec's build order puts the naive reverse-chronological
 * feed at step 6 and the ranker at 8-10. There is no honest score to show yet.
 *
 * Mounting this now would mean inventing one, and a fabricated score rendered
 * as though measured is worse than no panel at all: it is advice, a seller will
 * act on it, and it would be wrong. So this waits for its data source, exactly
 * as the scoring library does.
 *
 * To mount it, in the video report page: build an AlgorithmInput from the
 * ranker's ScoreComponents plus the benchmarks that page already computes, call
 * explainVideo(), and render <AlgorithmPanel explanation={...} />. It sits
 * alongside HowThisRanks — that section explains the ranking in general, this
 * one explains THIS video.
 */

function ScoreHeader({ explanation }: { explanation: AlgorithmExplanation }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <span data-num className="font-display text-[34px] font-extrabold leading-none tracking-[-0.03em] text-ink">
        {explanation.scoreLabel}
      </span>
      {explanation.percentileLabel ? (
        <span className="text-[13px] font-semibold text-muted">{explanation.percentileLabel}</span>
      ) : (
        // Honest absence. A video with too little history to rank says so,
        // rather than borrowing a percentile it has not earned.
        <span className="text-[13px] text-muted">not ranked yet</span>
      )}
    </div>
  );
}

function HelpingRow({ factor }: { factor: HelpingFactor }) {
  return (
    <li className="flex gap-3">
      <span aria-hidden className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-lime" />
      <span className="min-w-0">
        <span className="block text-[14px] font-bold text-ink">{factor.label}</span>
        <span className="block text-[13.5px] leading-relaxed text-muted">{factor.detail}</span>
      </span>
    </li>
  );
}

function HurtingRow({ factor }: { factor: HurtingFactor }) {
  return (
    <li className="flex gap-3">
      <span aria-hidden className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-coral" />
      <span className="min-w-0">
        <span className="block text-[14px] font-bold text-ink">{factor.label}</span>
        <span className="block text-[13.5px] leading-relaxed text-muted">{factor.detail}</span>
        {/* The lever. Visually tied to the number above it — indented under the
            detail, in ink rather than muted, so it reads as the answer to the
            problem and not as a footnote. */}
        <span className="mt-1.5 flex gap-1.5 text-[13.5px] leading-relaxed text-ink">
          <span aria-hidden className="text-coral-deep">
            ↳
          </span>
          <span className="font-semibold">{factor.lever}</span>
        </span>
      </span>
    </li>
  );
}

function SkippedRow({ factor }: { factor: SkippedFactor }) {
  return (
    <li className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
      <span className="text-[13px] font-semibold text-ink">{factor.label}</span>
      <span className="text-[13px] text-muted">{factor.note}</span>
    </li>
  );
}

export default function AlgorithmPanel({
  explanation,
  className,
}: {
  explanation: AlgorithmExplanation;
  className?: string;
}) {
  const { helping, hurting, skipped } = explanation;

  return (
    <section
      className={`rounded-card bg-card p-5 shadow-card ${className ?? ''}`}
      aria-labelledby="algo-panel-heading"
    >
      <h2
        id="algo-panel-heading"
        className="text-[12px] font-extrabold uppercase tracking-[0.07em] text-violet"
      >
        How the feed is treating this video
      </h2>

      <div className="mt-3">
        <ScoreHeader explanation={explanation} />
      </div>

      {/* grid-cols-1 base is deliberate and load-bearing: a bare `grid` with
          only a md: override does NOT stack on mobile — CSS Grid places
          children side by side in implicit columns. That exact omission
          shipped a clipped hero in this repo once already. */}
      <div className="mt-6 grid grid-cols-1 gap-6 md:grid-cols-2">
        <div>
          <h3 className="text-[12px] font-extrabold uppercase tracking-[0.07em] text-muted">
            What&rsquo;s helping
          </h3>
          {helping.length > 0 ? (
            <ul className="mt-3 flex flex-col gap-3">
              {helping.map((f) => (
                <HelpingRow key={f.key} factor={f} />
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-[13.5px] leading-relaxed text-muted">
              Nothing is pushing this one up yet. That is normal for a new post — the feed needs
              views before it can tell what is working.
            </p>
          )}
        </div>

        <div>
          <h3 className="text-[12px] font-extrabold uppercase tracking-[0.07em] text-muted">
            What&rsquo;s hurting
          </h3>
          {hurting.length > 0 ? (
            <ul className="mt-3 flex flex-col gap-4">
              {hurting.map((f) => (
                <HurtingRow key={f.key} factor={f} />
              ))}
            </ul>
          ) : (
            // An empty hurting column is a real and common answer. Inventing a
            // weakness to balance the layout would be a lie, and a seller who
            // is told to fix something that is not broken stops trusting the
            // panel that told them.
            <p className="mt-3 text-[13.5px] leading-relaxed text-muted">
              Nothing is holding this back right now.
            </p>
          )}
        </div>
      </div>

      {skipped.length > 0 && (
        <div className="mt-6 border-t border-hairline pt-4">
          <h3 className="text-[12px] font-extrabold uppercase tracking-[0.07em] text-muted">
            Not judged yet
          </h3>
          <ul className="mt-3 flex flex-col gap-2">
            {skipped.map((f) => (
              <SkippedRow key={f.key} factor={f} />
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
