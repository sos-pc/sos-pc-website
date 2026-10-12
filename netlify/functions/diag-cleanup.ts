import type { Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { DIAG_STORE, SESSION_TTL_MS } from "../lib/diag-shared.js";

// Scheduled (hourly): deletes diagnostic reports nobody came back for.
// Claimed reports are already removed by diag-poll.

export default async () => {
  const store = getStore(DIAG_STORE);
  const { blobs } = await store.list();
  const now = Date.now();
  let deleted = 0;

  for (const { key } of blobs) {
    try {
      const meta = await store.getMetadata(key);
      let createdAt = Date.parse(String(meta?.metadata?.createdAt ?? ""));
      if (Number.isNaN(createdAt)) {
        const entry: any = await store.get(key, { type: "json" });
        createdAt = Date.parse(entry?.created_at || "");
      }
      if (Number.isNaN(createdAt) || now - createdAt >= SESSION_TTL_MS) {
        await store.delete(key);
        deleted++;
      }
    } catch (err) {
      console.error("diag-cleanup: failed on", key, err);
    }
  }

  console.log(`diag-cleanup: ${deleted} expired session(s) deleted, ${blobs.length - deleted} kept`);
};

export const config: Config = { schedule: "@hourly" };
