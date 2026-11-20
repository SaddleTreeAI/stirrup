// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 SaddleTree AI

import type { Handler } from "../types.js";
import { importDocxHandler } from "./import-docx.js";
import { PURGE_CASE_KIND, purgeCaseHandler } from "./purge-case.js";
import { selftestHandler } from "./selftest.js";
import { transcribeHandler } from "./transcribe.js";

/**
 * Kind → handler registry. Later tasks add one file and one line here:
 *   P1:    import { extractPdfHandler } from "./extract-pdf.js"; handlers.extract_pdf = extractPdfHandler;
 */
export const handlers: Record<string, Handler> = {
  selftest: selftestHandler,
  import_docx: importDocxHandler,
  transcribe: transcribeHandler,
  [PURGE_CASE_KIND]: purgeCaseHandler,
};
