import type {
  AlgorithmExplanation,
  HelpingFactor,
  HurtingFactor,
  SkippedFactor,
} from '@/lib/studio/explain';
import { pct, progressPct } from '@/lib/studio/format';

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
  const { scoreLabel, percentilePct, percentileLabel } = explanation;

  return (
    <>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span
          data-num
          className="font-display text-[34px] font-extrabold leading-none tracking-[-0.03em] text-ink md:text-[42px]"
        >
          {scoreLabel}
        </span>
        {percentileLabel ? (
          <span className="text-[13px] font-semibold text-muted">{percentileLabel}</span>
        ) : (
          // Honest absence. A video with too little history to rank says so,
          // rather than borrowing a percentile it has not earned.
          <span className="text-[13px] text-muted">not ranked yet</span>
        )}
      </div>

      {/* The rank, drawn. The bar is the percentile and nothing else — it is
          never a progress bar toward a target, because there is no target. */}
      {percentilePct === null ? null : (
        <>
          <div
            role="img"
            aria-label={`Scores at or above ${pct(percentilePct)} of live videos`}
            className="mt-4 h-2.5 w-full overflow-hidden rounded-full bg-hairline-strong"
          >
            <div
              className="h-full rounded-full bg-coral transition-[width] duration-500 ease-out"
              style={{ width: `${progressPct(percentilePct, 100)}%` }}
            />
          </div>
          <p className="mt-2 text-[13px] leading-[1.5] text-muted">
            Where it sits against every video live right now.
          </p>
        </>
      )}
    </>
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

/**
 * The factors that reached neither column, by name.
 *
 * The two reasons are kept apart on purpose. "We have no number for this yet"
 * and "we have the number and it is doing nothing" are completely different
 * facts, and collapsing them into one list is how a seller comes away thinking
 * a measured, neutral factor is secretly counting against them.
 */
function SkippedGroup({
  caption,
  factors,
  className,
}: {
  caption: string;
  factors: SkippedFactor[];
  className?: string;
}) {
  return (
    <div className={className}>
      <h3 className="text-[12px] font-extrabold uppercase tracking-[0.07em] text-muted">
        {caption}
      </h3>
      <ul className="mt-3 flex flex-col gap-2">
        {factors.map((f) => (
          <li key={f.key} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="text-[13px] font-semibold text-ink">{f.label}</span>
            <span className="text-[13px] text-muted">{f.note}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export type AlgorithmPanelProps = {
  /** The ranked explanation, straight from `explainVideo()`. Nothing else. */
  explanation: AlgorithmExplanation;
  /** The video's title, for the panel's accessible name. Optional. */
  videoTitle?: string | null;
  /** Extra classes on the outer section, for page-level spacing. */
  className?: string;
};

export default function AlgorithmPanel({
  explanation,
  videoTitle,
  className,
}: AlgorithmPanelProps) {
  const { helping, hurting, skipped } = explanation;
  const unmeasured = skipped.filter((f) => f.reason === 'unmeasured');
  const neutral = skipped.filter((f) => f.reason === 'neutral');

  return (
    <section
      // aria-label rather than aria-labelledby: the videos list renders several
      // of these on one page, and a hardcoded element id would collide.
      aria-label={`How the feed is treating ${videoTitle || 'this video'}`}
      className={`rounded-card bg-card p-5 shadow-card md:p-7${className ? ` ${className}` : ''}`}
    >
      <h2 className="text-[12px] font-extrabold uppercase tracking-[0.07em] text-muted">
        How the feed is treating this video
      </h2>
      {videoTitle ? (
        <p className="mt-1 truncate text-[13px] font-semibold text-muted">{videoTitle}</p>
      ) : null}

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

        <div className="border-t border-hairline pt-6 md:border-l md:border-t-0 md:pl-6 md:pt-0">
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

      {/* Everything in neither column, named. NOT behind a disclosure: a seller
          who cannot see why a number is missing fills the gap in themselves,
          and what they fill it in with is a punishment nobody applied. */}
      {skipped.length > 0 && (
        <div className="mt-6 border-t border-hairline pt-4">
          {unmeasured.length > 0 && (
            <SkippedGroup caption="Not enough behind these to judge yet" factors={unmeasured} />
          )}
          {neutral.length > 0 && (
            <SkippedGroup
              caption="Measured, and moving nothing either way"
              factors={neutral}
              className={unmeasured.length > 0 ? 'mt-5' : undefined}
            />
          )}
        </div>
      )}

      {/* The claim the two rules add up to, said out loud. It is true by
          construction: explainVideo() accounts for every factor exactly once
          across the three lists, and all three are rendered above. */}
      <p className="mt-5 text-[12px] leading-[1.55] text-muted">
        Every factor the feed weighs on a video is on this page — helping, hurting,
        or not yet judged. Nothing about your ranking is kept off it.
      </p>
    </section>
  );
}
