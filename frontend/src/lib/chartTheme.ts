import { useEffect, useState } from "react";

const TOKENS = {
  forecast: "--series-forecast",
  actual: "--series-actual",
  error: "--series-error",
  muted: "--text-muted",
  grid: "--grid",
  axis: "--axis",
  text: "--text-secondary",
  surface: "--surface",
  missing: "--missing-fill",
  highlight: "--highlight-fill",
  overFill: "--band-over",
  underFill: "--band-under",
} as const;

export type ChartColors = Record<keyof typeof TOKENS, string>;

function read(): ChartColors {
  const style = getComputedStyle(document.documentElement);
  return Object.fromEntries(
    Object.entries(TOKENS).map(([key, token]) => [key, style.getPropertyValue(token).trim()]),
  ) as ChartColors;
}

export function useChartColors(): ChartColors {
  const [colors, setColors] = useState(read);
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setColors(read());
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);
  return colors;
}

export const axisTick = (colors: ChartColors) => ({ fill: colors.muted, fontSize: 12 });
