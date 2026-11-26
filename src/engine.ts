/**
 * Delivery engine — pure functions, no I/O, no Cloudflare imports.
 * This is the part the tests pin down.
 *
 * Model (same shape as Revive): every eligible banner competes inside its
 * campaign's *priority band*. The best (numerically lowest) band that has an
 * eligible banner wins, and the winner inside that band is chosen by weight.
 * That gives an advertiser the ability to say "always beat the house ad"
 * (priority) and "run my two creatives 70/30" (weight).
 */

export interface Candidate {
  id: number;
  campaignId: number;
  campaignName?: string;
  name: string;
  type: 'image' | 'html' | 'text';
  imageKey: string;
  html: string;
  targetUrl: string;
  width: number;
  height: number;
  alt: string;
  weight: number;
  priority: number;
  impCap: number;
  clickCap: number;
  /** Campaign-level page targeting, evaluated against the host page URL. */
  pageAllow: string;
  pageBlock: string;
  campaignImpressions: number;
  campaignClicks: number;
  status: string;
  campaignStatus: string;
  startsAt: string;
  endsAt: string;
}

export interface SelectOptions {
  /** 0..1 source of randomness — injected so tests are deterministic. */
  rand: number;
  /** Today in the reporting timezone, YYYY-MM-DD. */
  day: string;
  /** Banner ids this visitor has already seen (rotation / frequency control). */
  recentIds?: number[];
}

function inDateWindow(c: Candidate, day: string): boolean {
  const start = (c.startsAt || '').slice(0, 10);
  const end = (c.endsAt || '').slice(0, 10);
  if (start && day < start) return false;
  if (end && day > end) return false;
  return true;
}

/** Everything that disqualifies a banner before any randomness happens. */
export function isEligible(c: Candidate, day: string): boolean {
  if (c.status !== 'active' || c.campaignStatus !== 'active') return false;
  if (!inDateWindow(c, day)) return false;
  if (!c.imageKey && !c.html) return false; // nothing to render
  if (c.impCap > 0 && c.campaignImpressions >= c.impCap) return false;
  if (c.clickCap > 0 && c.campaignClicks >= c.clickCap) return false;
  return true;
}

/**
 * Only creatives shaped like the slot may compete for it. A 728x90 leaderboard
 * must never land in a 250x250 box: the renderer would squash it. Exact pixels
 * are not required — a 300x300 creative fits a 250x250 slot and is scaled down
 * — so compare aspect ratios with a small tolerance. A zero dimension means
 * "fluid/unknown" on either side and is not constrained.
 */
export function fitsSlot(
  banner: Pick<Candidate, 'width' | 'height'>,
  slotWidth: number,
  slotHeight: number,
): boolean {
  const bw = Math.max(0, banner.width);
  const bh = Math.max(0, banner.height);
  const sw = Math.max(0, slotWidth);
  const sh = Math.max(0, slotHeight);

  if (!bw || !bh) return true; // creative size not recorded: do not block it
  if (sw > 0 && sh > 0) {
    // Cross-multiply to avoid float division; 5% covers rounding in designs.
    return Math.abs(bw * sh - bh * sw) <= 0.05 * sw * sh;
  }
  if (sw > 0) return bw === sw;
  if (sh > 0) return bh === sh;
  return true;
}

/** Weighted draw: higher weight = larger share of voice within a band. */
export function weightedPick(pool: Candidate[], rand: number): Candidate | null {
  if (pool.length === 0) return null;
  const total = pool.reduce((sum, c) => sum + Math.max(1, c.weight), 0);
  let target = Math.min(0.999999, Math.max(0, rand)) * total;
  for (const c of pool) {
    target -= Math.max(1, c.weight);
    if (target < 0) return c;
  }
  return pool[pool.length - 1] ?? null;
}

export function selectBanner(candidates: Candidate[], options: SelectOptions): Candidate | null {
  const eligible = candidates.filter((c) => isEligible(c, options.day));
  if (eligible.length === 0) return null;

  const bestPriority = Math.min(...eligible.map((c) => c.priority));
  const band = eligible.filter((c) => c.priority === bestPriority);

  // Rotation: prefer a banner this visitor has not just seen. If that would
  // leave nothing, fall back to the full band rather than serving no ad.
  const recent = new Set(options.recentIds ?? []);
  const fresh = band.filter((c) => !recent.has(c.id));
  return weightedPick(fresh.length > 0 ? fresh : band, options.rand);
}

// ---------------------------------------------------------------------------
// Page targeting
// ---------------------------------------------------------------------------

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

export function pathOf(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return url.startsWith('/') ? url : `/${url}`;
  }
}

function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

function hostMatches(pattern: string, host: string): boolean {
  if (!host) return false;
  if (wildcardToRegExp(pattern).test(host)) return true;
  if (pattern.includes('*')) return false;
  return host === pattern || host.endsWith(`.${pattern}`) || host.replace(/^www\./, '') === pattern;
}

/**
 * Patterns, one per line in the zone's allow/block lists:
 *   example.com            host is example.com or any subdomain of it
 *   *.example.com          host matches the wildcard
 *   /blog*                 path (including query string) matches the wildcard
 *   example.com/private*   host and path must both match
 *   https://a.com/x*       full URL prefix
 */
export function matchesPattern(pattern: string, pageUrl: string): boolean {
  const p = pattern.trim();
  if (!p) return false;

  if (p.startsWith('/')) {
    return wildcardToRegExp(p).test(pathOf(pageUrl));
  }

  if (/^https?:\/\//i.test(p)) {
    const re = wildcardToRegExp(p.endsWith('*') ? p : `${p.replace(/\/$/, '')}*`);
    return re.test(pageUrl);
  }

  // host, or host/path
  const slash = p.indexOf('/');
  if (slash > 0) {
    const hostPattern = p.slice(0, slash);
    const pathPattern = p.slice(slash);
    if (!hostMatches(hostPattern, hostOf(pageUrl))) return false;
    return wildcardToRegExp(pathPattern).test(pathOf(pageUrl));
  }

  return hostMatches(p, hostOf(pageUrl));
}

function splitLines(value: string): string[] {
  return String(value ?? '')
    .split(/[\n,]/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * A zone only serves on pages it is allowed to. Block always wins. An empty
 * allow list means "any page" (the usual case for a tag pasted on a site).
 */
export function pageAllowed(pageAllow: string, pageBlock: string, pageUrl: string): boolean {
  const blocked = splitLines(pageBlock);
  if (blocked.some((pattern) => matchesPattern(pattern, pageUrl))) return false;

  const allowed = splitLines(pageAllow);
  if (allowed.length === 0) return true;
  return allowed.some((pattern) => matchesPattern(pattern, pageUrl));
}

// ---------------------------------------------------------------------------
// Macros — Revive-style placeholders inside html/text creatives and fallbacks
// ---------------------------------------------------------------------------

export function applyMacros(
  template: string,
  values: Record<string, string | number>,
): string {
  return String(template ?? '').replace(/\{\{\s*([A-Z_0-9]+)\s*\}\}/gi, (match, name: string) => {
    const key = name.toUpperCase();
    return Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match;
  });
}

export const SUPPORTED_MACROS = [
  'CLICK_URL',
  'BANNER_ID',
  'ZONE_ID',
  'CAMPAIGN_ID',
  'CACHEBUSTER',
  'AD_WIDTH',
  'AD_HEIGHT',
  'PAGE_URL',
] as const;
