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
   * Async copy of a database. Node: online backup. bun: serialize + write.
   * Resolves with the number of pages copied (0 on the bun path).
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  backup: (source: any, destination: string) => Promise<number>;
  /** "node:sqlite" or "bun:sqlite" - which backend is active. */
  backend: string;
  /** Find named parameters (@x, :x, $x) in SQL, skipping literals/comments. */
  findNamedParams: (sql: string) => string[];
  /** Translate bare-key named params to bun:sqlite's prefixed keys. */
  mapNamedParams: (sql: string, params: unknown[]) => unknown[];
};

export = api;
