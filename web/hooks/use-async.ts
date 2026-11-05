"use client";
import { useEffect, useRef, useState, useCallback } from "react";
import { errMsg } from "@/lib/utils";

export function useAsync<T>(fn: () => Promise<T>) {
  const fnRef = useRef(fn);
  useEffect(() => { fnRef.current = fn; });
  const [tick, setTick] = useState(0);
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean }>({
    data: null, error: null, loading: true,
  });

  useEffect(() => {
    let live = true;
    fnRef.current()
      .then((data) => live && setState({ data, error: null, loading: false }))
      .catch((e) => live && setState((s) => ({ data: s.data, error: errMsg(e), loading: false })));
    return () => { live = false; };
  }, [tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { ...state, reload };
}

