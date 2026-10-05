/**
 * Service worker (Chrome, Edge) or event page (Firefox): every listener is
 * registered in the first turn, as MV3 requires. The logic is in worker.ts.
 */
import { start } from "./worker.js";

void start();
