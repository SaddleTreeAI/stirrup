// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 SaddleTree AI

import type { Handler } from "../types.js";
import { extractPdfHandler } from "./extract-pdf.js";
import { selftestHandler } from "./selftest.js";

/**
 * Kind → handler registry. Later tasks add one file and one line here:
 *   DOC1:  import { extractDocxHandler } from "./extract-docx.js"; handlers.extract_docx = extractDocxHandler;
 *   V1:    import { transcribeHandler } from "./transcribe.js"; handlers.transcribe = transcribeHandler;
 */
export const handlers: Record<string, Handler> = {
  selftest: selftestHandler,
  extract_pdf: extractPdfHandler,
};
