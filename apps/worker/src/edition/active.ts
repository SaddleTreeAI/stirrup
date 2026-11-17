// edition-seam:A1-server
import { defaultEdition } from "@rakazo/edition-default/server";
import { lawEdition } from "@rakazo/edition-law/server";
import { resolveEdition } from "@rakazo/edition-sdk";

const registry = {
  default: defaultEdition,
  law: lawEdition,
};

/** Resolve after loadRootEnv() so STIRRUP_EDITION is available. */
export function getEdition() {
  return resolveEdition(process.env.STIRRUP_EDITION ?? "default", registry);
}

/** Lazily resolved active edition (do not read at module load). */
export const edition = {
  get current() {
    return getEdition();
  },
};
