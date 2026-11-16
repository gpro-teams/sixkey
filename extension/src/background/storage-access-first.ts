// Imported first by sw.ts, so that its body is the first code of the worker to run (ES modules run in import order). The
// three calls are started here, before the runtime exists and before any listener or storage read; sw.ts reports a
// failure. storage.sync's is apart (platform/storage-access.ts restrictSyncAccess): its answer is the backup in Chrome
// sync's gate for this worker's life (the maintainers' C7), never autofill's.
import { restrictStorageAccess, restrictSyncAccess } from "../platform/storage-access";

export const storageAccess = restrictStorageAccess();
export const syncAccess = restrictSyncAccess();
