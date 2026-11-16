// A controller's state in a view: re-rendered whenever the controller sets a new one (store.ts). A state set between the
// render and the subscription (an answer that arrives before the effect runs) is caught when the effect subscribes: the
// view compares what it drew with what is there now.
import { useEffect, useRef, useState } from "preact/hooks";
import type { Store } from "./store";

export function useStore<S>(c: Store<S>): S {
  const [, tick] = useState(0);
  const drawn = useRef<S>(c.state);
  drawn.current = c.state;
  useEffect(() => {
    const off = c.subscribe(() => tick((n) => n + 1));
    if (c.state !== drawn.current) tick((n) => n + 1);
    return off;
  }, [c]);
  return c.state;
}
