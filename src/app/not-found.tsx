export default function NotFound() {
  return (
    <div className="grain flex min-h-dvh flex-col items-center justify-center bg-ink px-5">
      <div className="relative z-10 w-full max-w-md text-center">
        <div className="font-mono text-xs uppercase tracking-[0.3em] text-acid">404</div>
        <h1 className="mt-5 font-display text-4xl font-extrabold tracking-tight text-paper">
          This drop is gone
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-dim">
          It may have sold out and been archived, or the link might be mistyped.
        </p>
        <a
          href="/"
          className="mt-8 inline-flex rounded-full bg-acid px-6 py-3 font-semibold text-ink transition hover:brightness-110"
        >
          Back to Drip
        </a>
      </div>
    </div>
  );
}
