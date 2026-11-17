import type { ShellExtension } from "@rakazo/edition-sdk";
import { defineWebEdition } from "@rakazo/edition-sdk";

const EMPTY: ShellExtension = {};

export const edition = defineWebEdition({
  id: "law",
  useShellExtension: () => EMPTY,
});

export default edition;
