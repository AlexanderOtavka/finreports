import type { Config } from "../config.js";
import type { Db } from "../db.js";
import { FireflyAdapter } from "./firefly.js";
import { SampleAdapter } from "./sample.js";
import type { BackendAdapter } from "./types.js";

export type { BackendAdapter } from "./types.js";

export function createAdapter(config: Config, db: Db): BackendAdapter {
  switch (config.backend) {
    case "firefly":
      return new FireflyAdapter({
        baseUrl: config.firefly.url,
        token: config.firefly.token!,
        initialSyncDays: config.firefly.initialSyncDays,
      });
    case "sample":
      return new SampleAdapter(db, { seed: config.sample.seed, endDate: config.sample.endDate });
  }
}
