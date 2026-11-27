import { initials } from "../format.js";

/** The signed-in GitHub account in the header of `/teams` and `/team`: its initials and `@login` (`#account`), drawn as text. */
export function paintAccount(doc: Document, login: string | null): void {
  (doc.getElementById("account") as HTMLElement).hidden = login === null;
  (doc.getElementById("login") as HTMLElement).textContent = login === null ? "" : `@${login}`;
  (doc.getElementById("initials") as HTMLElement).textContent = login === null ? "" : initials(login.replace(/[-_]+/g, " "));
}
