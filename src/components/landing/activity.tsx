// A depicted stream of the app's notification cards, doubled for the loop.
// Page copy makes no activity claims — these are the interface.

const TOASTS: { icon: React.ReactNode; text: React.ReactNode }[] = [
  {
    icon: <span className="grid h-6 w-6 place-items-center rounded-full bg-violet/10 text-[10px] font-bold text-violet ring-[1.5px] ring-violet">MF</span>,
    text: <><b>Maya</b> saved the Halo Desk Lamp</>,
  },
  {
    icon: <span className="anim-dot h-2 w-2 rounded-full bg-cobalt" />,
    text: <>Crescent Crossbody “Butter” is back in stock</>,
  },
  {
    icon: <span className="grid h-6 w-6 place-items-center rounded-full bg-violet/10 text-[10px] font-bold text-violet ring-[1.5px] ring-violet">TB</span>,
    text: <><b>Theo</b> added 3 things to <i>Desk refresh</i></>,
  },
  {
    icon: <span className="text-[13px] font-bold text-sale">↓</span>,
    text: <>Price drop on your list: Pebble Buds Mini</>,
  },
  {
    icon: <span className="grid h-6 w-6 place-items-center rounded-full bg-violet/10 text-[10px] font-bold text-violet ring-[1.5px] ring-violet">SS</span>,
    text: <><b>Sofia</b> published <i>Slow Sunday</i> picks</>,
  },
  {
    icon: <span className="rounded-full bg-lime px-2 py-0.5 text-[10px] font-bold text-ink">NEW</span>,
    text: <>Suncourt just dropped The Sorbet Pack</>,
  },
];

export default function Activity() {
  return (
    <div className="-mx-5 overflow-hidden md:-mx-6">
      <div className="anim-ticker flex w-max gap-3 px-5 md:px-6">
        {[...TOASTS, ...TOASTS].map((t, i) => (
          <div
            key={i}
            className="flex shrink-0 items-center gap-2.5 rounded-full bg-card px-4 py-2.5 shadow-float"
            aria-hidden={i >= TOASTS.length}
          >
            {t.icon}
            <span className="whitespace-nowrap text-[13px] font-medium text-ink">{t.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
