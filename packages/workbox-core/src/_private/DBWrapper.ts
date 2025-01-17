/*
  Copyright 2018 Google LLC

  Use of this source code is governed by an MIT-style
  license that can be found in the LICENSE file or at
  https://opensource.org/licenses/MIT.
*/

import '../_version.js';


type IDBObjectStoreMethods = 'get' | 'count' | 'getKey' | 'getAll' |
    'getAllKeys' | 'add' | 'put' | 'clear' | 'delete';

type Query = IDBValidKey | IDBKeyRange | null;

interface DBWrapperOptions {
  onupgradeneeded?: (event: IDBVersionChangeEvent) => any;
  onversionchange?: (event: IDBVersionChangeEvent) => any;
}

interface GetAllMatchingOptions {
  index?: string,
  query?: Query,
  direction?: IDBCursorDirection,
  count?: number,
  includeKeys?: boolean,
}

/**
 * A class that wraps common IndexedDB functionality in a promise-based API.
 * It exposes all the underlying power and functionality of IndexedDB, but
 * wraps the most commonly used features in a way that's much simpler to use.
 *
 * @private
 */
export class DBWrapper {
  private _name: string;
  private _version: number;
  private _onupgradeneeded?: DBWrapperOptions['onupgradeneeded'];
  private _onversionchange: DBWrapperOptions['onversionchange'];
  private _db: IDBDatabase | null = null;

  // The following IDBObjectStore methods are shadowed on this class.
  get: Function;
  count: Function;
  add: Function;
  put: Function;
  clear: Function;
  delete: Function;

  OPEN_TIMEOUT: number;

  /**
   * @param {string} name
   * @param {number} version
   * @param {Object=} [callback]
   * @param {!Function} [callbacks.onupgradeneeded]
   * @param {!Function} [callbacks.onversionchange] Defaults to
   *     DBWrapper.prototype._onversionchange when not specified.
   * @private
   */
  constructor(name: string, version: number, {
    onupgradeneeded,
    onversionchange,
  } : DBWrapperOptions = {}) {
    this._name = name;
    this._version = version;
    this._onupgradeneeded = onupgradeneeded;
    this._onversionchange = onversionchange || (() => this.close());
  }

  /**
   * Returns the IDBDatabase instance (not normally needed).
   * @return {IDBDatabase|undefined}
   *
   * @private
   */
  get db() : IDBDatabase | null {
    return this._db;
  }

  /**
   * Opens a connected to an IDBDatabase, invokes any onupgradedneeded
   * callback, and added an onversionchange callback to the database.
   *
   * @return {IDBDatabase}
   * @private
   */
  async open() {
    if (this._db) return;

    this._db = await new Promise((resolve, reject) => {
      // This flag is flipped to true if the timeout callback runs prior
      // to the request failing or succeeding. Note: we use a timeout instead
      // of an onblocked handler since there are cases where onblocked will
      // never never run. A timeout better handles all possible scenarios:
      // https://github.com/w3c/IndexedDB/issues/223
      let openRequestTimedOut = false;
      setTimeout(() => {
        openRequestTimedOut = true;
        reject(new Error('The open request was blocked and timed out'));
      }, this.OPEN_TIMEOUT);

      const openRequest = indexedDB.open(this._name, this._version);
      openRequest.onerror = () => reject(openRequest.error);
      openRequest.onupgradeneeded = (evt: IDBVersionChangeEvent) => {
        if (openRequestTimedOut) {
          openRequest.transaction!.abort();
          openRequest.result.close();
        } else if (typeof this._onupgradeneeded === 'function') {
          this._onupgradeneeded(evt);
        }
      };
      openRequest.onsuccess = () => {
        const db = openRequest.result;
        if (openRequestTimedOut) {
          db.close();
        } else {
          db.onversionchange = this._onversionchange!.bind(this);
          resolve(db);
        }
      };
    });

    return this;
  }

  /**
   * Polyfills the native `getKey()` method. Note, this is overridden at
   * runtime if the browser supports the native method.
   *
   * @param {string} storeName
   * @param {*} query
   * @return {Array}
   * @private
   */
  async getKey(storeName: string, query: Query) {
    return (await this.getAllKeys(storeName, query, 1))[0];
  }

  /**
   * Polyfills the native `getAll()` method. Note, this is overridden at
   * runtime if the browser supports the native method.
   *
   * @param {string} storeName
   * @param {*} query
   * @param {number} count
   * @return {Array}
   * @private
   */
  async getAll(storeName: string, query?: Query, count?: number) {
    return await this.getAllMatching(storeName, {query, count});
  }


  /**
   * Polyfills the native `getAllKeys()` method. Note, this is overridden at
   * runtime if the browser supports the native method.
   *
   * @param {string} storeName
   * @param {*} query
   * @param {number} count
   * @return {Array}
   * @private
   */
  async getAllKeys(storeName: string, query: Query, count: number) {
    const entries = await this.getAllMatching(
        storeName, {query, count, includeKeys: true})

    return entries.map((entry: IDBCursor) => entry.key);
  }

  /**
   * Supports flexible lookup in an object store by specifying an index,
   * query, direction, and count. This method returns an array of objects
   * with the signature .
   *
   * @param {string} storeName
   * @param {Object} [opts]
   * @param {string} [opts.index] The index to use (if specified).
   * @param {*} [opts.query]
   * @param {IDBCursorDirection} [opts.direction]
   * @param {number} [opts.count] The max number of results to return.
   * @param {boolean} [opts.includeKeys] When true, the structure of the
   *     returned objects is changed from an array of values to an array of
   *     objects in the form {key, primaryKey, value}.
   * @return {Array}
   * @private
   */
  async getAllMatching(storeName: string, {
    index,
    query = null, // IE/Edge errors if query === `undefined`.
    direction = 'next',
    count,
    includeKeys = false,
  } : GetAllMatchingOptions = {}) : Promise<Array<IDBCursor | any>> {
    return await this.transaction([storeName], 'readonly', (txn, done) => {
      const store = txn.objectStore(storeName);
      const target = index ? store.index(index) : store;
      const results: any[] = [];
      const request = target.openCursor(query, direction);

      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor) {
          results.push(includeKeys ? cursor : cursor.value);
          if (count && results.length >= count) {
            done(results);
          } else {
            cursor.continue();
          }
        } else {
          done(results);
        }
      };
    });
  }

  /**
   * Accepts a list of stores, a transaction type, and a callback and
   * performs a transaction. A promise is returned that resolves to whatever
   * value the callback chooses. The callback holds all the transaction logic
   * and is invoked with two arguments:
   *   1. The IDBTransaction object
   *   2. A `done` function, that's used to resolve the promise when
   *      when the transaction is done, if passed a value, the promise is
   *      resolved to that value.
   *
   * @param {Array<string>} storeNames An array of object store names
   *     involved in the transaction.
   * @param {string} type Can be `readonly` or `readwrite`.
   * @param {!Function} callback
   * @return {*} The result of the transaction ran by the callback.
   * @private
   */
  async transaction(
    storeNames: string | string[],
    type: IDBTransactionMode,
    callback: (txn: IDBTransaction, done: Function) => void,
  ) : Promise<any> {
    await this.open();
    return await new Promise((resolve, reject) => {
      const txn = this._db!.transaction(storeNames, type);
      txn.onabort = () => reject(txn.error);
      txn.oncomplete = () => resolve();

      callback(txn, (value: any) => resolve(value));
    });
  }

  /**
   * Delegates async to a native IDBObjectStore method.
   *
   * @param {string} method The method name.
   * @param {string} storeName The object store name.
   * @param {string} type Can be `readonly` or `readwrite`.
   * @param {...*} args The list of args to pass to the native method.
   * @return {*} The result of the transaction.
   * @private
   */
  async _call(
    method: IDBObjectStoreMethods,
    storeName: string,
    type: IDBTransactionMode,
    ...args: any[]
  ) {
    const callback = (txn: IDBTransaction, done: Function) => {
      const objStore = txn.objectStore(storeName)
      const request = <IDBRequest> objStore[method].apply(objStore, args);

      request.onsuccess = () => done(request.result);
    };

    return await this.transaction([storeName], type, callback);
  }

  /**
   * Closes the connection opened by `DBWrapper.open()`. Generally this method
   * doesn't need to be called since:
   *   1. It's usually better to keep a connection open since opening
   *      a new connection is somewhat slow.
   *   2. Connections are automatically closed when the reference is
   *      garbage collected.
   * The primary use case for needing to close a connection is when another
   * reference (typically in another tab) needs to upgrade it and would be
   * blocked by the current, open connection.
   *
   * @private
   */
  close() {
    if (this._db) {
      this._db.close();
      this._db = null;
    }
  }
}

// Exposed on the prototype to let users modify the default timeout on a
// per-instance or global basis.
DBWrapper.prototype.OPEN_TIMEOUT = 2000;


// Wrap native IDBObjectStore methods according to their mode.
const methodsToWrap = {
  readonly: ['get', 'count', 'getKey', 'getAll', 'getAllKeys'],
  readwrite: ['add', 'put', 'clear', 'delete'],
};
for (const [mode, methods] of Object.entries(methodsToWrap)) {
  for (const method of methods) {
    if (method in IDBObjectStore.prototype) {
      // Don't use arrow functions here since we're outside of the class.
      DBWrapper.prototype[<IDBObjectStoreMethods> method] =
          async function(storeName: string, ...args: any[]) {
            return await this._call(
                <IDBObjectStoreMethods> method,
                storeName,
                <IDBTransactionMode> mode,
                ...args);
          };
    }
  }
}
