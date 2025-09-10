export function getCapacity(comp){ return Number(comp?.totalTickets ?? comp?.capacity ?? 0); }
export function getSold(comp){ return Number(comp?.ticketsSold ?? comp?.soldCount ?? 0); }

export function resolveCloseMode(comp){
  // Default to "date" unless explicitly "sellout"
  return (comp?.closeMode === "sellout") ? "sellout" : "date";
}

export function toMillis(ts){
  if (!ts) return 0;
  if (typeof ts.toMillis === "function") return ts.toMillis();
  const n = new Date(ts).getTime();
  return Number.isFinite(n) ? n : 0;
}

export function computeState(comp){
  const capacity = getCapacity(comp);
  const sold = getSold(comp);
  const left = Math.max(0, capacity - sold);
  if (capacity > 0 && left === 0) return "sold_out";

  if (resolveCloseMode(comp) === "date"){
    const endMs = toMillis(comp?.closeAt);
    if (endMs && Date.now() >= endMs) return "closed";
  }
  return "live";
}

export function formatLeft(comp){
  return Math.max(0, getCapacity(comp) - getSold(comp));
}

export function startCountdown(closeAt, el){
  const endMs = toMillis(closeAt);
  if (!el || !endMs) return; // no-op if no date
  function tick(){
    const diff = endMs - Date.now();
    if (diff <= 0){ el.textContent = "Closed"; return; }
    const s = Math.floor(diff/1000), d = Math.floor(s/86400);
    const h = Math.floor((s%86400)/3600), m = Math.floor((s%3600)/60), sec = s%60;
    el.textContent = d>0 ? `${d}d ${h}h ${m}m` : `${h}h ${m}m ${sec}s`;
    setTimeout(tick, 500);
  }
  tick();
}
