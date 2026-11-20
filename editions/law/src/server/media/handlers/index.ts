// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 SaddleTree AI

import type { Handler } from "../types.js";
import { extractPdfHandler } from "./extract-pdf.js";
import { importDocxHandler } from "./import-docx.js";
import { ocrPdfHandler } from "./ocr-pdf.js";
import { PURGE_CASE_KIND, purgeCaseHandler } from "./purge-case.js";
import { selftestHandler } from "./selftest.js";
import { transcribeHandler } from "./transcribe.js";

/**
 * Kind → handler registry. Later tasks add one file and one line here.
 */
export const handlers: Record<string, Handler> = {
  selftest: selftestHandler,
  extract_pdf: extractPdfHandler,
  ocr_pdf: ocrPdfHandler,
  import_docx: importDocxHandler,
  transcribe: transcribeHandler,
  [PURGE_CASE_KIND]: purgeCaseHandler,
};
