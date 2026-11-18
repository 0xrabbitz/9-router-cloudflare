/**
 * Create a transaction runner that supports both synchronous callbacks
 * (used by migrate/backup) and async callbacks (used by D1-compatible repos).
 * Concurrent async transactions are serialized via an in-process mutex so
 * read-modify-write sequences never interleave across awaits.
 *
 * @param {((sql: string) => void) | null} execSql - Sync SQL executor (null for D1)
 * @param {(() => void) | undefined} [onCommit] - Optional post-commit hook
 */
export function createTransactionRunner(execSql, onCommit) {
  let locked = false;
  const waiters = [];

  function release() {
    const next = waiters.shift();
    if (next) next();
    else locked = false;
  }

  function acquire() {
    if (!locked) {
      locked = true;
      return null;
    }
    return new Promise((resolve) => waiters.push(resolve));
  }

  function runWithSql(fn) {
    if (execSql) execSql("BEGIN IMMEDIATE");
    try {
      const res = fn();
      if (res && typeof res.then === "function") {
        return res.then(
          (val) => {
            if (execSql) execSql("COMMIT");
            onCommit?.();
            release();
            return val;
          },
          (err) => {
            if (execSql) {
              try { execSql("ROLLBACK"); } catch {}
            }
            release();
            throw err;
          }
        );
      }
      if (execSql) execSql("COMMIT");
      onCommit?.();
      release();
      return res;
    } catch (err) {
      if (execSql) {
        try { execSql("ROLLBACK"); } catch {}
      }
      release();
      throw err;
    }
  }

  return function transaction(fn) {
    const wait = acquire();
    if (!wait) return runWithSql(fn);
    return wait.then(() => runWithSql(fn));
  };
}
