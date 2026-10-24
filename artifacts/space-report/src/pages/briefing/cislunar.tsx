import { useEffect, useState } from "react";
import { Link } from "wouter";
import { ChevronLeft, ExternalLink, Moon } from "lucide-react";
import { Line, LineChart, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";

const PAGE_TITLE = "Bureau Briefing: The Cislunar Situation | Other Jonathan's Space Report";
const PAGE_DESCRIPTION =
  "The Pentagon now calls cislunar a warfighting domain. The Bureau checked what the word means, where it starts, and whether saying it makes you sound important.";

const BD_URL =
  "https://breakingdefense.com/2026/10/space-force-shifts-into-high-gear-on-cislunar-warfare-with-rfis-coming-soon/";

type Tone = "success" | "warning" | "danger";
const toneClass: Record<Tone, string> = {
  success: "border-emerald-500/40 text-emerald-300 bg-emerald-950/30",
  warning: "border-amber-500/40 text-amber-300 bg-amber-950/30",
  danger: "border-rose-500/40 text-rose-300 bg-rose-950/30",
};

const ORIGIN: [string, string, string, Tone][] = [
  ["1877", "OED's earliest evidence for cis-lunar, in George F. Chambers's writing. Merriam-Webster also says circa 1877.", "Verified", "success"],
  ["1865–70", "Collins and Dictionary.com say 'first recorded 1865–70'. They give no citation.", "Unverified", "warning"],
  ["1872", "A 2026 arXiv primer puts cislunar in 1870s eclipse and solar-corona writing.", "Secondary source", "warning"],
  ["1955–62", "Krafft Ehricke uses cislunar as a formal subdomain of circumterrestrial space, per the same primer.", "Secondary source", "warning"],
  ["1965", "Google Books usage peaks as the Apollo program ramps up.", "Verified", "success"],
  ["Sep 3, 2020", "AFRL announces CHPS, the Cislunar Highway Patrol System.", "Verified", "success"],
  ["Mar 21, 2022", "AFRL seeks industry partners for CHPS, calling the region 'one thousand times greater than our current area of responsibility'.", "Verified", "success"],
  ["Nov 2022", "The White House publishes its National Cislunar S&T Strategy.", "Verified", "success"],
  ["Oct 22, 2026", "Space Force announces cislunar RFIs and calls it a warfighting domain.", "Verified", "success"],
];

// Google Books Ngram, English, smoothing 3, 1965 peak = 100. Points every ~5 years 1940–2022.
const NGRAM = [
  { year: "1940", value: 0 }, { year: "1945", value: 0 }, { year: "1950", value: 1 }, { year: "1955", value: 6 },
  { year: "1960", value: 53 }, { year: "1965", value: 100 }, { year: "1970", value: 49 }, { year: "1975", value: 17 },
  { year: "1980", value: 8 }, { year: "1985", value: 12 }, { year: "1990", value: 14 }, { year: "1995", value: 10 },
  { year: "2000", value: 5 }, { year: "2005", value: 5 }, { year: "2010", value: 9 }, { year: "2015", value: 12 },
  { year: "2020", value: 14 }, { year: "2022", value: 15 },
];

const REGIMES = [
  ["LEO", "Cisterran-adjacent (or just: low)", "180–2,000 km"],
  ["MEO", "Cis-GEO, mid-shelf", "2,000–35,780 km"],
  ["GEO", "The Belt", "35,786 km"],
  ["Beyond GEO", "xGEO (this one is real)", "35,786 km and up"],
  ["Past the Moon", "Translunar, then honestly just space", "384,400 km and up"],
];

const OFFICIAL = [
  ["US Code, 42 USC 18302", "Earth itself", "Around the lunar surface"],
  ["White House NSTC, Nov 2022", "Beyond GEO (35,786 km)", "Where Earth/Moon gravity stops dominating"],
  ["ExoAnalytic, AMOS 2021", "GEO, 1.0 xGEO", "Just past Earth-Moon L2, near 450,000 km"],
  ["AFRL Cislunar Primer", "Beyond GEO", "Transfers can exceed 1.5M km"],
  ["Earth's Hill sphere", "n/a", "About 1.5M km"],
  ["Breaking Defense caption", "Beyond Earth's orbit", "Out to the Moon"],
];

const LADDER = [
  { label: "ITU deep space starts", value: 2000000, display: "2,000,000 km" },
  { label: "Earth's Hill sphere", value: 1500000, display: "1,500,000 km" },
  { label: "Earth-Moon L2", value: 448900, display: "448,900 km" },
  { label: "Moon's orbit", value: 384400, display: "384,400 km" },
  { label: "GEO", value: 35786, display: "35,786 km" },
  { label: "Top of LEO", value: 2000, display: "2,000 km" },
];

const RELEVANCE = [
  { label: "\"Cislunar warfighting domain\"", value: 98 },
  { label: "\"Cislunar\" in an RFI title", value: 85 },
  { label: "\"xGEO\"", value: 60 },
  { label: "\"Beyond GEO\"", value: 35 },
  { label: "\"Near the Moon\"", value: 10 },
];

const VERDICTS: [string, string, string, Tone][] = [
  ["Yes, if", "you say which definition you mean and what orbit you are talking about.", "Relevant", "success"],
  ["Sort of, if", "you say it while pointing at a Lagrange point diagram.", "Adjacent", "warning"],
  ["No, if", "you use it for anything in LEO without a straight face.", "Buzzword", "danger"],
];

const HISTORY_SOURCES = [
  ["OED: cis-lunar", "https://www.oed.com/dictionary/cis-lunar_adj"],
  ["Merriam-Webster: cislunar", "https://www.merriam-webster.com/dictionary/cislunar"],
  ["Collins: cislunar", "https://www.collinsdictionary.com/dictionary/english/cislunar"],
  ["arXiv primer (2026)", "https://arxiv.org/html/2606.26367"],
  ["Google Books Ngram: cislunar", "https://books.google.com/ngrams/graph?content=cislunar&year_start=1940&year_end=2022&corpus=en&smoothing=3"],
  ["AFRL: two new space flight experiments (CHPS)", "https://www.afrl.af.mil/News/Article-Display/Article/2361147/afrl-announces-two-new-space-flight-experiments/"],
  ["AFRL: CHPS seeks industry collaboration", "https://www.afrl.af.mil/News/Article/2972971/afrls-cislunar-highway-patrol-system-seeks-industry-collaboration/"],
];

const SOURCES = [
  { title: "Space Force shifts into high gear on cislunar warfare", site: "Breaking Defense", date: "Oct 22, 2026", href: BD_URL },
  { title: "National Cislunar Science & Technology Strategy", site: "White House NSTC", date: "Nov 2022", href: "https://bidenwhitehouse.archives.gov/wp-content/uploads/2022/11/11-2022-NSTC-National-Cislunar-ST-Strategy.pdf" },
  { title: "Aspirations in Cislunar Space (quotes 42 USC 18302)", site: "Aerospace CSPS", date: "Oct 2024", href: "https://csps.aerospace.org/sites/default/files/2024-10/06d_Moonstruck_Bukley-Stover_20241022_0.pdf" },
  { title: "42 USC 18302: Definitions", site: "uscode.house.gov", href: "https://uscode.house.gov/view.xhtml?req=granuleid:USC-prelim-title42-section18302&num=0&edition=prelim" },
  { title: "A Primer on Cislunar Space", site: "AFRL", date: "2021", href: "https://www.afrl.af.mil/Portals/90/Documents/RV/A%20Primer%20on%20Cislunar%20Space_Dist%20A_PA2021-1271.pdf" },
  { title: "Distinct orbit families in the cislunar domain (xGEO)", site: "AMOS 2021", href: "https://amostech.com/TechnicalPapers/2021/Poster/Cunio.pdf" },
  { title: "Outer space: regions near Earth (Hill sphere, L2, ITU deep space, orbit bands)", site: "Wikipedia", href: "https://en.wikipedia.org/wiki/Outer_space" },
  { title: "cis- etymology", site: "Etymonline", href: "https://www.etymonline.com/word/cis-" },
];

function useBriefingMetadata() {
  useEffect(() => {
    const previousTitle = document.title;
    const selectors = [
      ["meta[name='description']", PAGE_DESCRIPTION],
      ["meta[property='og:title']", PAGE_TITLE],
      ["meta[property='og:description']", PAGE_DESCRIPTION],
      ["meta[name='twitter:title']", PAGE_TITLE],
      ["meta[name='twitter:description']", PAGE_DESCRIPTION],
    ] as const;
    const previous = selectors.map(([s]) => {
      const el = document.querySelector<HTMLMetaElement>(s);
      return [el, el?.content] as const;
    });
    document.title = PAGE_TITLE;
    selectors.forEach(([s, c]) => {
      const el = document.querySelector<HTMLMetaElement>(s);
      if (el) el.content = c;
    });
    return () => {
      document.title = previousTitle;
      previous.forEach(([el, c]) => {
        if (el && c !== undefined) el.content = c;
      });
    };
  }, []);
}

function Ext({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline break-words">
      {children}
    </a>
  );
}

function Section({ heading, children }: { heading: string; children: React.ReactNode }) {
  return (
    <section className="space-y-4">
      <h2 className="text-primary font-mono uppercase tracking-widest text-sm border-b border-primary/20 pb-2">{heading}</h2>
      {children}
    </section>
  );
}

function Grid({ columns, rows }: { columns: string[]; rows: React.ReactNode[][] }) {
  return (
    <div className="overflow-x-auto border border-border">
      <table className="w-full text-sm">
        <thead className="bg-card/60 font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
          <tr>{columns.map((c) => <th key={c} className="text-left p-2">{c}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-t border-border/60 align-top">
              {r.map((cell, j) => <td key={j} className="p-2">{cell}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Badge({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return <span className={`inline-block whitespace-nowrap border px-2 py-0.5 font-mono text-[10px] uppercase ${toneClass[tone]}`}>{children}</span>;
}

function HBars({ bars, emphasis }: { bars: { label: string; value: number; display: string }[]; emphasis: number }) {
  const max = Math.max(...bars.map((b) => b.value));
  return (
    <div className="space-y-2 font-mono text-xs">
      {bars.map((b, i) => (
        <div key={b.label} className="grid grid-cols-[minmax(0,14rem)_1fr_auto] items-center gap-3">
          <span className="text-muted-foreground truncate">{b.label}</span>
          <div className="h-3 bg-card/60 border border-border/50">
            <div className={`h-full ${i === emphasis ? "bg-primary" : "bg-primary/40"}`} style={{ width: `${Math.max(0.5, (b.value / max) * 100)}%` }} />
          </div>
          <span className={i === emphasis ? "text-primary" : "text-foreground"}>{b.display}</span>
        </div>
      ))}
    </div>
  );
}

export default function CislunarBriefing() {
  useBriefingMetadata();
  const [mode, setMode] = useState<"official" | "literal">("official");

  return (
    <article className="max-w-3xl mx-auto space-y-10 pb-16" data-testid="briefing-cislunar">
      <Link href="/briefing" className="inline-flex items-center gap-1 font-mono text-xs text-muted-foreground hover:text-primary">
        <ChevronLeft className="w-3 h-3" /> BACK TO BRIEFING
      </Link>

      <header className="space-y-3">
        <div className="font-mono text-[11px] uppercase tracking-widest text-sky-300/80 flex items-center gap-2">
          <Moon className="w-3 h-3" /> Bureau Briefing · CASE #CISLUNAR-0001 · Oct 23, 2026
        </div>
        <h1 className="text-3xl font-bold tracking-tight">Bureau Briefing: The Cislunar Situation</h1>
        <p className="text-muted-foreground">{PAGE_DESCRIPTION}</p>
      </header>

      <Section heading="The occasion">
        <blockquote className="border-l-2 border-primary pl-4 italic">
          “At the beginning of the year … there was no talk of cislunar, and basically I was told: 'Don't talk about cislunar and stop getting into it.'”
          <footer className="not-italic font-mono text-xs text-muted-foreground mt-2">
            — Maj. Gen. Stephen Purdy, via <Ext href={BD_URL}>Breaking Defense</Ext>, Oct 22, 2026
          </footer>
        </blockquote>
        <p>By year end, per the same piece, the Space Force plans two RFIs (commercial cislunar tech, and AI autonomy for spacecraft between Earth and the Moon) and wants fieldable kit by the end of fiscal 2029. The article's own photo caption defines cislunar as the region beyond Earth's orbit all the way out to the Moon. Hold that thought.</p>
      </Section>

      <Section heading="1. The etymology problem">
        <p>Latin <em>cis</em> means on this side of; <em>trans</em> means across. Cisalpine Gaul was Rome's side of the Alps. So cislunar literally means on this side of the Moon, which from where we sit is everything from your roof to lunar orbit.</p>
        <p>By the dictionary, the ISS, Starlink, your GPS, and the weather sat over Kansas are all cislunar. Kosmos 2612 tailing ICEYE-X36 in LEO this week? Technically a cislunar stakeout.</p>
        <p className="font-mono text-xs text-muted-foreground">Source: <Ext href="https://www.etymonline.com/word/cis-">Etymonline, cis-</Ext></p>
      </Section>

      <Section heading="Origin story">
        <Grid columns={["When", "What happened", "Status"]} rows={ORIGIN.map(([w, t, s, tone]) => [<span className="font-mono whitespace-nowrap">{w}</span>, t, <Badge tone={tone}>{s}</Badge>])} />
        <div className="border border-border bg-card/30 p-3">
          <div className="font-mono text-[11px] uppercase text-muted-foreground mb-2">cislunar, Google Books English (1965 peak = 100)</div>
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={NGRAM} margin={{ top: 5, right: 10, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis dataKey="year" tick={{ fontSize: 10 }} />
                <YAxis domain={[0, 100]} tick={{ fontSize: 10 }} />
                <Tooltip contentStyle={{ background: "rgba(0,0,0,0.85)", border: "1px solid hsl(var(--border))", fontSize: 12 }} />
                <Line type="monotone" dataKey="value" name="relative usage" stroke="hsl(var(--primary))" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
        <p>Reading the chart: the word was a Moon-race word, nearly died after Apollo, and its usage has roughly tripled since 2000. That climb comes from defense and policy circles. It's still about one-seventh of 1965 levels in books, though it's clearly winning on PowerPoint. The Ngram data stops at 2022, so it doesn't show this year's warfighting-domain bump.</p>
        <p className="font-mono text-xs text-muted-foreground">
          Sources:{" "}
          {HISTORY_SOURCES.map(([label, href], i) => (
            <span key={href}>{i > 0 && " · "}<Ext href={href}>{label}</Ext></span>
          ))}
        </p>
      </Section>

      <Section heading="2. Fine, then name the rest">
        <p>If cis-the-Moon is a domain, the Bureau proposes a matching set. None of these are official. All of them are as defensible as the original.</p>
        <Grid columns={["Regime", "Bureau term", "Altitude"]} rows={REGIMES} />
        <p>xGEO is genuine US usage: distance counted in multiples of the GEO radius. Earth-Moon L2 sits around 10.7 xGEO. It is ugly, but at least it is a ruler.</p>
      </Section>

      <Section heading="3. Where the line actually is">
        <div className="inline-flex border border-border font-mono text-xs">
          {([["official", "Official definitions"], ["literal", "Distance ladder"]] as const).map(([v, label]) => (
            <button key={v} type="button" onClick={() => setMode(v)} className={`px-3 py-1.5 ${mode === v ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}>
              {label}
            </button>
          ))}
        </div>
        {mode === "official" ? <Grid columns={["Who", "Inner edge", "Outer edge"]} rows={OFFICIAL} /> : <HBars bars={LADDER} emphasis={4} />}
        <p>The law says cislunar starts at the ground. The White House says it starts at GEO. The physics says Earth's gravity wins out to about 1.5M km, roughly four Moon distances. Same word, three answers, depending on who is filing the budget.</p>
        <div className="border border-primary/40 bg-primary/5 p-4">
          <span className="font-mono text-xs uppercase tracking-widest text-primary">Bureau ruling. </span>
          Under the 2022 strategy, cislunar is xGEO with a Moon in it. Under the US Code, it is everything, including LEO. Pick one before you put it in an RFI.
        </div>
      </Section>

      <Section heading="4. Does saying it make you sound relevant?">
        <HBars bars={RELEVANCE.map((r) => ({ ...r, display: `${r.value} / 100` }))} emphasis={0} />
        <p className="text-xs text-muted-foreground">Scores are the Bureau's own, measured in conference-badge gravity, not data.</p>
        <div className="space-y-2">
          {VERDICTS.map(([title, detail, label, tone]) => (
            <div key={title} className="flex items-start justify-between gap-4 border border-border bg-card/30 p-3">
              <div><span className="font-semibold">{title}</span> <span className="text-muted-foreground">{detail}</span></div>
              <Badge tone={tone}>{label}</Badge>
            </div>
          ))}
        </div>
      </Section>

      <Section heading="Sources">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {SOURCES.map((s) => (
            <a key={s.href} href={s.href} target="_blank" rel="noopener noreferrer" className="block border border-primary/20 p-3 hover:border-primary/50 hover:bg-primary/5 transition-colors group">
              <div className="flex justify-between items-start gap-2 text-sm">
                <span>{s.title}</span>
                <ExternalLink className="w-3 h-3 shrink-0 opacity-50 group-hover:opacity-100" />
              </div>
              <div className="font-mono text-[11px] text-muted-foreground mt-1">{s.site}{s.date ? ` · ${s.date}` : ""}</div>
            </a>
          ))}
        </div>
      </Section>
    </article>
  );
}
