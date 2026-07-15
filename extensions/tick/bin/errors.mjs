// errors.mjs — the one place every subcommand module throws through.

import { PiTickError } from "./catalog.mjs";

export function fail(message, code = 1) {
  throw new PiTickError(message, code);
}
