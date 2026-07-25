import { useState } from "react";
import { useGetSatcatPasses, getGetSatcatPassesQueryKey } from "@workspace/api-client-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2, Crosshair, Eye, EyeOff } from "lucide-react";

/**
 * Pass / visibility finder: enter (or geolocate) an observer position and
 * list upcoming horizon-to-horizon passes for the selected satellite,
 * flagged VISIBLE when the satellite is sunlit while the observer is in
 * twilight/darkness.
 */
export default function PassFinder({ norad, name }: { norad: number; name?: string }) {
  const [latInput, setLatInput] = useState("");
  const [lonInput, setLonInput] = useState("");
  const [days, setDays] = useState("3");
  const [coords, setCoords] = useState<{ lat: number; lon: number } | null>(null);
  const [geoBusy, setGeoBusy] = useState(false);
  const [inputError, setInputError] = useState<string | null>(null);

  const params = coords ? { norad, lat: coords.lat, lon: coords.lon, days: Number(days) } : undefined;
  const { data, isLoading, isError, error } = useGetSatcatPasses(
    params ?? { norad, lat: 0, lon: 0 },
    {
      query: {
        enabled: !!params,
        queryKey: getGetSatcatPassesQueryKey(params ?? { norad, lat: 0, lon: 0 }),
        staleTime: 5 * 60_000,
        retry: false,
      },
    },
  );

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const lat = parseFloat(latInput);
    const lon = parseFloat(lonInput);
    if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lon) || lon < -180 || lon > 180) {
      setInputError("Latitude must be -90..90, longitude -180..180");
      return;
    }
    setInputError(null);
    setCoords({ lat, lon });
  };

  const useMyLocation = () => {
    if (!navigator.geolocation) {
      setInputError("Geolocation not available in this terminal");
      return;
    }
    setGeoBusy(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const lat = Math.round(pos.coords.latitude * 1000) / 1000;
        const lon = Math.round(pos.coords.longitude * 1000) / 1000;
        setLatInput(String(lat));
        setLonInput(String(lon));
        setInputError(null);
        setCoords({ lat, lon });
        setGeoBusy(false);
      },
      () => {
        setInputError("Position fix denied — enter coordinates manually");
        setGeoBusy(false);
      },
      { timeout: 10_000 },
    );
  };

  const fmt = (iso: string) =>
    new Date(iso).toLocaleString(undefined, {
      weekday: "short", month: "short", day: "numeric",
      hour: "2-digit", minute: "2-digit",
    });
  const duration = (a: string, b: string) => {
    const s = Math.round((Date.parse(b) - Date.parse(a)) / 1000);
    return `${Math.floor(s / 60)}m ${s % 60}s`;
  };
  const compass = (az: number) => {
    const dirs = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
    return dirs[Math.round(az / 22.5) % 16];
  };

  const apiStatus = (error as { status?: number } | null)?.status;

  return (
    <div className="p-4 space-y-3">
      <div className="font-mono text-[10px] uppercase tracking-widest text-primary font-bold flex items-center gap-2">
        <Crosshair className="w-3.5 h-3.5" />
        Pass Finder — when can I see {name || `object ${norad}`}?
      </div>

      <form onSubmit={submit} noValidate className="flex flex-wrap items-center gap-2">
        <Input
          type="number" step="any" min={-90} max={90}
          placeholder="LAT °"
          value={latInput}
          onChange={(e) => setLatInput(e.target.value)}
          className="w-[110px] rounded-none border-border bg-background text-xs font-mono"
        />
        <Input
          type="number" step="any" min={-180} max={180}
          placeholder="LON °"
          value={lonInput}
          onChange={(e) => setLonInput(e.target.value)}
          className="w-[110px] rounded-none border-border bg-background text-xs font-mono"
        />
        <Select value={days} onValueChange={setDays}>
          <SelectTrigger className="w-[110px] rounded-none border-border bg-background uppercase text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="rounded-none">
            {["1", "2", "3", "5", "7"].map((d) => (
              <SelectItem key={d} value={d}>{d} day{d === "1" ? "" : "s"}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button type="submit" variant="outline" size="sm" className="rounded-none border-primary text-primary hover:bg-primary hover:text-primary-foreground uppercase text-xs">
          Predict Passes
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={useMyLocation} disabled={geoBusy} className="rounded-none border-border text-muted-foreground hover:text-primary uppercase text-xs">
          {geoBusy ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : null}
          Use my location
        </Button>
      </form>

      {inputError && <div className="text-destructive font-mono text-[10px] uppercase">{inputError}</div>}

      {coords && isLoading && (
        <div className="flex items-center gap-2 text-primary font-mono text-[10px] uppercase tracking-widest">
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> Propagating SGP4 over {coords.lat}°, {coords.lon}°…
        </div>
      )}
      {coords && isError && (
        <div className="text-destructive font-mono text-[10px] uppercase">
          {apiStatus === 404
            ? "No current element set on file with space command — cannot predict passes."
            : "Uplink to space-track failed — try again shortly."}
        </div>
      )}
      {coords && data && data.passes.length === 0 && (
        <div className="text-muted-foreground font-mono text-[10px] uppercase">
          No passes above the horizon at {coords.lat}°, {coords.lon}° within {data.days} day(s). The sky owes you nothing.
        </div>
      )}
      {coords && data && data.passes.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full font-mono text-[11px] whitespace-nowrap">
            <thead>
              <tr className="text-muted-foreground uppercase text-[9px] tracking-widest border-b border-border/60 text-left">
                <th className="py-1 pr-4">Rise</th>
                <th className="py-1 pr-4">Peak</th>
                <th className="py-1 pr-4">Set</th>
                <th className="py-1 pr-4">Max Elev</th>
                <th className="py-1 pr-4">Track</th>
                <th className="py-1 pr-4">Duration</th>
                <th className="py-1">Naked-Eye</th>
              </tr>
            </thead>
            <tbody>
              {data.passes.map((p, i) => (
                <tr key={i} className={`border-b border-border/30 ${p.visible ? "text-foreground" : "text-muted-foreground"}`}>
                  <td className="py-1.5 pr-4">{fmt(p.startTime)}</td>
                  <td className="py-1.5 pr-4">{fmt(p.maxTime)}</td>
                  <td className="py-1.5 pr-4">{fmt(p.endTime)}</td>
                  <td className={`py-1.5 pr-4 font-bold ${p.maxElevationDeg >= 45 ? "text-primary" : ""}`}>{p.maxElevationDeg}°</td>
                  <td className="py-1.5 pr-4">{compass(p.startAzDeg)} → {compass(p.maxAzDeg)} → {compass(p.endAzDeg)}</td>
                  <td className="py-1.5 pr-4">{duration(p.startTime, p.endTime)}</td>
                  <td className="py-1.5">
                    {p.visible ? (
                      <span className="inline-flex items-center gap-1 text-primary font-bold uppercase"><Eye className="w-3 h-3" /> Visible</span>
                    ) : (
                      <span className="inline-flex items-center gap-1 uppercase opacity-60"><EyeOff className="w-3 h-3" /> In shadow / daylight</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="mt-2 text-muted-foreground/70 font-mono text-[9px] uppercase tracking-widest">
            Times local · elements epoch {data.epoch.slice(0, 16).replace("T", " ")} UTC · VISIBLE = satellite sunlit, observer sky dark, elevation &gt; 10°
          </div>
        </div>
      )}
    </div>
  );
}
