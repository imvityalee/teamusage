import { bootPage, type Page, type Reply } from "../site/page.fixture.js";

/** Opens `/teams<suffix>` (a query and a fragment) and answers each request with the next reply (tests only). */
export const boot = (suffix: string, ...replies: Reply[]): Promise<Page> =>
  bootPage({ url: `/teams${suffix}`, html: "teams.html", load: () => import("./main.js") }, replies);
