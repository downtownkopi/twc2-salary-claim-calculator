// Barrel re-export — this file used to hold everything directly (461 lines covering image
// preprocessing, the low-level vision API client, and page-level scan operations), split out into
// lib/ocr/{images,visionClient,pageScan}.ts for readability. Every existing `from "./ocr"` import
// across the codebase (server.ts, lib/ipa.ts, lib/bankstatement.ts, lib/medicalbills.ts) keeps
// working unchanged — this is purely an internal reorganization, not a public API change.
export * from "./ocr/images";
export * from "./ocr/visionClient";
export * from "./ocr/pageScan";
