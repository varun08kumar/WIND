import { useEffect, useState } from "react";
import type { Accuracy, DeliveryDay, LeadTime, Meta, Series, Vintages } from "../types/api";

const BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, "") ?? "";

export class ApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

async function getJson<T>(path: string, params: Record<string, string>, signal: AbortSignal): Promise<T> {
  const query = new URLSearchParams(params).toString();
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}${query ? `?${query}` : ""}`, { signal });
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err;
    throw new ApiError("Can’t reach the API. Check that the backend is running, then retry.");
  }
  if (!response.ok) {
    let detail = `Request failed (HTTP ${response.status}).`;
    const body = await response.json().catch(() => null);
    if (typeof body?.detail === "string") detail = body.detail;
    throw new ApiError(detail, response.status);
  }
  return (await response.json()) as T;
}

export const api = {
  meta: (s: AbortSignal) => getJson<Meta>("/api/meta", {}, s),
  day: (date: string, s: AbortSignal) => getJson<DeliveryDay>("/api/forecasts/latest", { date }, s),
  series: (from: string, to: string, s: AbortSignal) => getJson<Series>("/api/forecasts/series", { from, to }, s),
  vintages: (startTime: string, s: AbortSignal) =>
    getJson<Vintages>("/api/forecasts/vintages", { start_time: startTime }, s),
  accuracy: (from: string, to: string, s: AbortSignal) => getJson<Accuracy>("/api/accuracy", { from, to }, s),
  leadTime: (from: string, to: string, s: AbortSignal) =>
    getJson<LeadTime>("/api/accuracy/lead-time", { from, to }, s),
};

export interface Resource<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  retry: () => void;
}

/** Fetch on key change. Keeps the previous data while refetching so charts hold their frame. */
export function useResource<T>(key: string | null, load: (signal: AbortSignal) => Promise<T>): Resource<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (key === null) return;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    load(controller.signal)
      .then((result) => setData(result))
      .catch((err: Error) => {
        if (err.name !== "AbortError") setError(err.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, attempt]);

  return { data, error, loading, retry: () => setAttempt((n) => n + 1) };
}
