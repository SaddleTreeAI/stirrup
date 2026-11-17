import type { ShellExtension } from "@rakazo/edition-sdk";
import { defineWebEdition } from "@rakazo/edition-sdk";

const EMPTY: ShellExtension = {};

export const edition = defineWebEdition({
  id: "default",
  useShellExtension: () => EMPTY,
});

export default edition;
