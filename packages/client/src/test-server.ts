// Test helper only (not part of the CLI bundle): a real server on an ephemeral loopback port.
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { createApp } from "../../server/src/app.js";
import { openDb, type Db } from "../../server/src/db.js";
import { ensureSingleTeam, singleTeamCodes } from "../../server/src/teams.js";

export interface TestServer {
  url: string;
  db: Db;
  close: () => Promise<void>;
}

export async function startServer(inviteCode: string): Promise<TestServer> {
  const db = openDb(":memory:");
  const app = createApp(db, { teamForCode: singleTeamCodes(ensureSingleTeam(db), () => inviteCode) });
  const server = await new Promise<Server>((resolve) => {
    const s = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolve(s as Server));
  });
  const { port } = server.address() as AddressInfo;
  let closed = false;
  return {
    url: `http://127.0.0.1:${port}`,
    db,
    close: () =>
      new Promise<void>((resolve) => {
        if (closed) return resolve();
        closed = true;
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export const countRows = (db: Db, table: string): number =>
  (db.prepare(`select count(*) as n from ${table}`).get() as { n: number }).n;
