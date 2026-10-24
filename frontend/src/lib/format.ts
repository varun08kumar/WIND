export const UK_TZ = "Europe/London";
const LOCALE = "en-GB";

const timeFmt = new Intl.DateTimeFormat(LOCALE, { timeZone: UK_TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const offsetFmt = new Intl.DateTimeFormat("en-US", { timeZone: UK_TZ, timeZoneName: "shortOffset" });
const dateTimeFmt = new Intl.DateTimeFormat(LOCALE, {
  timeZone: UK_TZ, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
const shortDateTimeFmt = new Intl.DateTimeFormat(LOCALE, {
  timeZone: UK_TZ, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
const dayFmt = new Intl.DateTimeFormat(LOCALE, { timeZone: "UTC", weekday: "short", day: "numeric", month: "short", year: "numeric" });
const shortDayFmt = new Intl.DateTimeFormat(LOCALE, { timeZone: "UTC", day: "numeric", month: "short" });
const mwFmt = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 0 });
const signedMwFmt = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 0, signDisplay: "exceptZero" });
const pctFmt = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 1 });
const hoursFmt = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 1 });

/** "GMT" or "BST" for the given instant (browsers disagree on short names, so derive it from the offset). */
export function ukZone(iso: string): string {
  const offset = offsetFmt.formatToParts(new Date(iso)).find((p) => p.type === "timeZoneName")?.value;
  if (offset === "GMT" || offset === "GMT+0") return "GMT";
  if (offset === "GMT+1") return "BST";
  return offset ?? "UK time";
}

const hourFmt = new Intl.DateTimeFormat(LOCALE, { timeZone: UK_TZ, hour: "numeric", hourCycle: "h23" });
export const ukHour = (iso: string) => Number(hourFmt.format(new Date(iso)));

const ymdFmt = new Intl.DateTimeFormat("en-CA", { timeZone: UK_TZ, year: "numeric", month: "2-digit", day: "2-digit" });
/** UK delivery date (YYYY-MM-DD) of an instant. */
export const ukDate = (iso: string) => ymdFmt.format(new Date(iso));

export const fmtTime = (iso: string) => timeFmt.format(new Date(iso));
export const fmtTimeZ = (iso: string) => `${fmtTime(iso)} ${ukZone(iso)}`;
export const fmtDateTime = (iso: string) => `${dateTimeFmt.format(new Date(iso))} ${ukZone(iso)}`;
export const fmtShortDateTime = (iso: string) => shortDateTimeFmt.format(new Date(iso));
export const fmtDay = (ymd: string) => dayFmt.format(new Date(`${ymd}T12:00:00Z`));
export const fmtShortDay = (ymd: string) => shortDayFmt.format(new Date(`${ymd}T12:00:00Z`));

export const fmtMw = (v: number | null | undefined) => (v == null ? "—" : `${mwFmt.format(v)} MW`);
export const fmtNum = (v: number | null | undefined) => (v == null ? "—" : mwFmt.format(v));
export const fmtSignedMw = (v: number | null | undefined) => (v == null ? "—" : `${signedMwFmt.format(v)} MW`);
export const fmtSignedNum = (v: number | null | undefined) => (v == null ? "—" : signedMwFmt.format(v));
export const fmtPct = (v: number | null | undefined) => (v == null ? "—" : `${pctFmt.format(v)}%`);
export const fmtHours = (v: number | null | undefined) => (v == null ? "—" : `${hoursFmt.format(v)} h`);

export function addDays(ymd: string, days: number): string {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
