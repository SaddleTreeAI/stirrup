// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 SaddleTree AI

import type { Handler } from "../types.js";
import { selftestHandler } from "./selftest.js";
import { transcribeHandler } from "./transcribe.js";

/**
 * Kind → handler registry. Later tasks add one file and one line here:
 *   P1:    import { extractPdfHandler } from "./extract-pdf.js"; handlers.extract_pdf = extractPdfHandler;
 *   DOC1:  import { extractDocxHandler } from "./extract-docx.js"; handlers.extract_docx = extractDocxHandler;
 */
export const handlers: Record<string, Handler> = {
  selftest: selftestHandler,
  transcribe: transcribeHandler,
};
