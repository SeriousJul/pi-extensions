/**
 * Type declaration for sqlite-shim.cjs.
 *
 * The active `DatabaseSync` is either Node's real `node:sqlite` class or
 * the bun:sqlite emulation in the shim; both expose the surface below,
 * which is all codegraph (and this extension) use.
 */
declare const api: {
  /**
   * `node:sqlite`'s DatabaseSync on Node >= 22.5, or the shim's
   * bun:sqlite-based emulation on bun. Supports the members codegraph's
   * adapter uses: prepare / exec / close / isOpen, plus `serialize()` on
   * the bun path.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  DatabaseSync: any;
  /**
   * Async copy of a database. Node 22.16+/23.8+: online backup. bun:
   * serialize + write. Undefined on Node 22.5-22.15 (no backup API) - use
   * `backupFile` there. Resolves with the number of pages copied (0 on the
   * bun path).
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  backup?: (source: any, destination: string) => Promise<number>;
  /**
   * Consistent copy without the backup API: WAL checkpoint + file copy.
   * The seed copy fallback for Node 22.5-22.15.
   */
  backupFile: (sourcePath: string, destinationPath: string) => Promise<void>;
  /** "node:sqlite" or "bun:sqlite" - which backend is active. */
  backend: string;
  /** Find named parameters (@x, :x, $x) in SQL, skipping literals/comments. */
  findNamedParams: (sql: string) => string[];
  /** Translate bare-key named params to bun:sqlite's prefixed keys. */
  mapNamedParams: (sql: string, params: unknown[]) => unknown[];
};

export = api;
