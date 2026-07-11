import { Anchor, ExternalLink } from "lucide-react";
import wireCatchImage from "@assets/image_1783733021394.png";

export function LongMarchCatchBulletin() {
  return (
    <div className="border border-red-400/30 bg-red-950/15 p-5 font-mono text-xs relative">
      <div className="absolute top-0 left-0 w-full h-[2px] bg-gradient-to-r from-red-400/60 via-red-400/20 to-transparent" />
      <div className="flex items-start gap-3">
        <Anchor className="w-5 h-5 text-red-400/80 shrink-0 mt-0.5" />
        <div className="space-y-3 w-full">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-red-400/20 pb-2">
            <span className="text-red-300/90 font-bold uppercase tracking-widest text-[11px]">
              Space Police — Field Bulletin
            </span>
            <span className="text-muted-foreground text-[10px] uppercase tracking-wider">
              Case #LM10B-0001 · Posted: 2026-07-10 · Status: NOTED WITH GRUDGING RESPECT
            </span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-1 text-[10px] text-muted-foreground uppercase tracking-wider">
            <span><span className="text-red-400/60">Filed by:</span> Bureau of Reusable Hardware</span>
            <span><span className="text-red-400/60">Re:</span> Long March 10B — Barge Recovery, Wire Arrest</span>
            <span><span className="text-red-400/60">Severity:</span> Impressive / Faintly Alarming</span>
          </div>

          <div className="space-y-3 text-muted-foreground leading-relaxed normal-case">
            <p>
              <span className="text-red-300 font-bold">Report:</span>{" "}
              Footage has surfaced of a <span className="text-foreground/80 font-bold">Long March 10B</span>{" "}
              (Chang Zheng 10B, CASC) executing a propulsive return to an <em>ocean-going barge</em> — and being
              secured not by landing legs, nor by a launch-tower's chopsticks, but by a{" "}
              <span className="text-foreground/80 font-bold">wire catch system</span>: arresting cables strung across
              the deck, in the venerable tradition of every aircraft carrier since 1911. The rocket came down. The
              wires caught it. Somewhere, a naval aviator felt a distant, unexplained sense of kinship.
            </p>
            <p>
              The Space Police have reviewed the imagery. We note, for the record, that humanity now has at least
              three competing philosophies for not throwing rockets away: legs on a droneship (SpaceX), chopsticks
              on a tower (also SpaceX), and now <em>cables on a boat</em> (CASC). We had assumed the design space
              for "catch the falling rocket" was more or less explored. We were wrong. We are frequently wrong. It
              is the one constant in this catalog.
            </p>
            <figure className="border border-red-400/20 bg-black/40 p-2">
              <img
                src={wireCatchImage}
                alt="Long March 10B first stage descending toward the wire-catch recovery structure on the ocean barge, engine burning during final approach"
                className="w-full h-auto block"
                loading="lazy"
              />
              <figcaption className="pt-2 text-[10px] text-red-400/50 uppercase tracking-wider">
                Exhibit A — The final approach. Frame from footage circulated by{" "}
                <a
                  href="https://x.com/raz_liu?s=21"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-red-300/80 underline underline-offset-2 hover:text-red-200 transition-colors"
                >
                  Ace of Razgriz
                </a>{" "}
                on X. Their footage, their credit — we are merely the filing cabinet.
              </figcaption>
            </figure>
            <p>
              <span className="text-red-300 font-bold">Provenance:</span>{" "}
              Original source appears to be the X account{" "}
              <a
                href="https://x.com/raz_liu?s=21"
                target="_blank"
                rel="noopener noreferrer"
                className="text-red-300/90 underline underline-offset-2 hover:text-red-200 transition-colors font-semibold inline-flex items-center gap-1"
              >
                Ace of Razgriz
                <ExternalLink className="w-3 h-3" />
              </a>
              . The Space Police did not shoot this footage, do not own it, and credit the source. We are a catalog,
              not a newsroom — but we know where we got the tip, and we say so.
            </p>
            <p className="text-muted-foreground/80 border-l-2 border-red-400/20 pl-3">
              A barge recovery is not an orbital flight, so nothing has entered the catalog yet. The moment a Long
              March 10 logs its first orbital payload, it will surface automatically on the{" "}
              <span className="text-red-300/70">Anticipated Heavy-Lift Contenders watchlist</span> over in Mass
              Analytics — where it, and one considerably less finished newcomer called{" "}
              <span className="text-foreground/70">Cowboy Space</span>, have already been added to the list of
              vehicles we are keeping an eye on.
            </p>
          </div>
          <div className="flex flex-col gap-1 border-t border-red-400/20 pt-2 text-[10px] text-red-400/40 uppercase tracking-wider">
            <span>— Bureau of Reusable Hardware</span>
            <span>Footage credited to source · Not independently re-flown by this office · Filed with reluctant admiration</span>
          </div>
        </div>
      </div>
    </div>
  );
}
