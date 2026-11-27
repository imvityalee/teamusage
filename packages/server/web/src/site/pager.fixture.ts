/** Picks `value` in a pager's select the way a person does: the value changes, then `change` fires (tests only). */
export function chooseSize(select: HTMLSelectElement, value: string): void {
  select.value = value;
  const change = select.ownerDocument.createEvent("Event");
  change.initEvent("change", true, false);
  select.dispatchEvent(change);
}
