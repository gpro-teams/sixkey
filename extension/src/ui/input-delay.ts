// The input delay of every Sixkey screen that something else can put in front of the user: Sixkey's own surface while it
// holds a page's fill request (popup/page-delay.ts; AUTOFILL2 patch 4a), as the removed plugin platform's screens had
// it. One constant, in a module of its own.
/** §6.4 item 4: input is ignored for this long after the screen is shown, and after its window gains the focus. */
export const INPUT_DELAY_MS = 600;
