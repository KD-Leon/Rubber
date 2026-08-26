/**
 * Entry point for the reranker-bundle.js Optional Asset.
 *
 * esbuild bundles this file as a standalone CommonJS bundle with
 * `@huggingface/transformers` and `onnxruntime-web/wasm` resolved and
 * tree-shaken. BundleLoader fetches the resulting file at runtime from
 * the {version}-assets GitHub release, verifies its SHA256, and evaluates
 * it via the indirect Function-constructor pattern.
 *
 * Only used during the reranker-bundle.js build (entry-point referenced
 * by esbuild.config.mjs generateOfficeBundles()). Not imported by main.ts.
 *
 * IMPORT ORDER IS LOAD-BEARING: ./ort-register MUST come before the
 * @huggingface/transformers import. It sets
 * globalThis[Symbol.for('onnxruntime')] to the onnxruntime-web/wasm build
 * as a side effect; transformers reads that symbol at module-init time to
 * pick its ONNX backend. If transformers evaluated first it would fall back
 * to onnxruntime-node (Electron is detected as a node env) and the reranker
 * would report "ONNX WASM backend not available". See ort-register.ts.
 *
 * We re-export the exact symbols RerankerService.initBackend() consumes:
 *  - `transformers.AutoModelForSequenceClassification`
 *  - `transformers.AutoTokenizer`
 *  - `transformers.env`                            (WASM cache flag)
 *  - `ort` = the whole `onnxruntime-web/wasm` module (also used to set
 *    onnxWasm.wasmBinary from the vault-pinned WASM asset).
 */

import { ortWasm } from './ort-register';
import * as transformersNs from '@huggingface/transformers';

export const transformers = transformersNs;
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- ortWasm is error-typed (runtime subpath without type declarations, see ort-register.ts); consumers type it via RerankerBundleExports
export const ort = ortWasm;
