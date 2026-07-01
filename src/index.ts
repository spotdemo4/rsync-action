import * as core from "@actions/core";

import { runAction } from "./action.ts";

try {
  await runAction();
} catch (error) {
  core.setFailed(error instanceof Error ? error.message : String(error));
}
