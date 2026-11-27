import { dt, type Text } from "./strings.js";

/** A hosted team's statistics that are busy are asked for once more after the wait the server names. */

/** The longest wait before asking again: the server's budget is per minute. */
const MAX_WAIT_SEC = 60;

/**
 * `ask` loads the statistics. A `busy` answer to a load is followed by one more load after its wait; a second `busy`
 * in a row is left to the Retry button. Any load drops a retry that is still waiting.
 */
export function busyRetry(ask: () => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let retrying = false;
  return {
    /** Called as a load starts: drops a waiting retry. True when this load is the retry. */
    begin(): boolean {
      clearTimeout(timer);
      timer = undefined;
      const retry = retrying;
      retrying = false;
      return retry;
    },
    /** After a `busy` answer: asks again after `retryAfterSec` seconds (MAX_WAIT_SEC at most) unless the load was the retry; returns what the status says. */
    answer(retryAfterSec: number, wasRetry: boolean): Text {
      if (wasRetry) return (lang) => dt(lang, "stillBusy");
      const wait = Math.max(1, Math.min(retryAfterSec, MAX_WAIT_SEC));
      timer = setTimeout(() => {
        retrying = true;
        ask();
      }, wait * 1000);
      return (lang) => dt(lang, "busy", { n: wait });
    },
  };
}
