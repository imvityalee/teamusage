/**
 * How a page shows one view at a time: an element with `data-view="x"` is shown only in view x, and an element with
 * `data-views="x y"` in each view it lists.
 */

/** Shows the `data-view` elements of `view` and hides the others. */
export function showView(views: readonly HTMLElement[], view: string): void {
  for (const el of views) el.hidden = el.dataset.view !== view;
}

/** True when `data-views` of `el` lists `view`. */
export const listsView = (el: HTMLElement, view: string): boolean => (el.dataset.views ?? "").split(" ").includes(view);
