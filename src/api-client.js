import { getDriver } from './lib/driver.js'
import { ApiError } from './lib/api-error'
import castArray from 'lodash/castArray'
import objectHash from 'object-hash'
import jwtDecode from 'jwt-decode'
import { ApiProxy } from './api-proxy.js'
import { ReduxClient } from './lib/redux-client.js'
import { queryParamEncode } from './lib/query-param-encoder.js'
import { debug } from './lib/debug.js'

Promise.each = async function (arr, fn) { // take an array and a function
  for (const item of arr) await fn(item)
}

let singleton

/**
 * @typedef {Object} ApiClientConfig
 * @property {Object} api - PleasureApi related configuration.
 * @property {String} [apiURL=http://localhost:3000/api] - URL to the API server
 * @property {String} [entitiesUri=/entities] - endpoint where to access the entities schema.
 * @property {String} [authEndpoint=/token] - endpoint where to exchange credentials for accessToken / refreshToken.
 * @property {String} [revokeEndpoint=/revoke] - endpoint where to exchange credentials for accessToken / refreshToken.
 * @property {Number} [timeout=15000] - axios timeout in ms.
 */

/**
 * Client for querying the API server.
 * @name ApiClient
 *
 * @see {@link pleasureClient} for a singleton instance of this class.
 *
 * @example
 *
 * ```js
 * // import { PleasureClient, getDriver } from 'pleasure'
 * // const { PleasureClient, getDriver } = require('pleasure')
 *
 * const myPleasureClient = new PleasureClient({ driver: getDriver({ appURL: 'http://my-api-url', timeout: 3000 }) })
 *
 * myPleasureClient
 *   .list('entity')
 *   .then(entries => {
 *     console.log(entries)
 *   })
 * ```
 */
export class ApiClient extends ReduxClient {
  /**
   * Initializes a client driver for the API server.
   * @constructor
   *
   * @param {Object} [options] - Options
   * @param {String} [options.name] - Client name
   * @param {Object} [options.driver] - Driver to issue ajax requests to the API server. Defaults to {@link getDriver}.
   * @param {ApiClientConfig} options.config - Optional object to override local configuration. See {@link ClientConfig}.
   * @param {String} [options.accessToken] - Optional accessToken in case to start the driver with a session.
   * @param {String} [options.refreshToken] - Optional refreshToken in case to start the driver with a session.
   * @param {Object} [options.reduxOptions] - Redux options. See {@link ReduxClient}.
   * @param {Boolean} [options.storeCredentials] - Whether to autoSave credentials (accessToken, refreshToken)
   * @param {Boolean} [options.credentialsStorage='localStorage'] - Whether `localStorage` or `sessionStorage`
   * @param {Boolean} [options.credentialsStorageName='pleasure-credentials'] - Whether to autoSave credentials (accessToken, refreshToken)
   */
  constructor (options = {}) {
    const { apiURL, timeout } = options.config
    const {
      driver = getDriver({
        apiURL,
        timeout
      }),
      config,
      reduxOptions = {},
      storeCredentials = true,
      credentialsStorage = 'localStorage',
      credentialsStorageName = 'pleasure-credentials',
      autoLoadCredentials = true
    } = options

    debug() && console.log(`initializing @pleasure-js/api-client`, { reduxOptions })
    const { baseURL } = driver.defaults
    super(baseURL, reduxOptions)

    const { accessToken, refreshToken } = Object.assign(this.savedCredentials(), options)

    this._autoLoadCredentials = autoLoadCredentials
    this._options = options
    this._name = options.name
    this._driver = driver
    this._userProfile = null
    this._daemonSessionExpired = null
    this._cache = []
    this.config = config
    this._storeCredentials = storeCredentials
    this._credentialsStorage = credentialsStorage
    this._credentialsStorageName = credentialsStorageName

    this.setCredentials({ accessToken, refreshToken })

    // return new Proxy(this, handler)
    const $this = this
    return ApiProxy({
      next: this.fetch.bind(this),
      methodCallback ({ method, args = [] }) {
        return $this[method](...args) || true
      }
    })
  }

  /**
   * Orchestrates returned
   * @param endpoint
   * @return {Promise<*>}
   */
  async fetch (endpoint) {
    return this.driver({
      url: endpoint.url,
      method: endpoint.method,
      params: {},
      data: Object.assign(Object.keys(endpoint.get).length > 0 ? { $params: endpoint.get } : {}, endpoint.body || {})
    })
  }

  savedCredentials () {
    const credentials = {}
    if (this._storeCredentials && process.client) {
      Object.assign(credentials, JSON.parse(window[this._credentialsStorage].getItem(this._credentialsStorageName) || '{}'))
    }
    // console.log(`credentials saved`, credentials)
    return credentials
  }

  static debug (v) {
    return debug(v)
  }

  setCredentials ({ accessToken = null, refreshToken = null } = {}) {
    if (this._storeCredentials && process.client) {
      window[this._credentialsStorage].setItem(this._credentialsStorageName, JSON.stringify({
        accessToken,
        refreshToken
      }))
    }
    this._accessToken = accessToken
    this._refreshToken = refreshToken

    // important in order to set authorization via constructor
    this._refreshCredentials()
  }

  async proxyCacheReq ({ id, req }) {
    let res
    await Promise.each(this._cache, async (CacheHook) => {
      res = await CacheHook.req({ id, req })
      if (typeof res !== 'undefined') {
        return false
      }
    })
    return res
  }

  async proxyCacheRes ({ id, req, res }) {
    await Promise.each(this._cache, async (CacheHook) => {
      await CacheHook.res({ id, req, res })
    })

    return res
  }

  async driver (req = {}) {
    const id = objectHash(req)
    const cache = await this.proxyCacheReq({ id, req })

    if (req.params) {
      req.params = queryParamEncode(req.params)
    }

    if (typeof cache !== 'undefined') {
      return cache
    }

    debug() && console.log(`@pleasure-js/api-client calling>`, { req }, `${ this.accessToken ? 'with auth' : ' without auth' }`)
    const res = await this._driver(req)

    this
      .proxyCacheRes({ id, req, res })
      .catch(err => {
        console.log(`Proxy cache res error:`, err)
      })

    return res
  }

  /**
   * @typedef {Object} CacheResult
   * @property {String} id - A unique identifier for the parameters of the request.
   * @property {String} req - The request.
   * @property {Object} data - The data being transferred by the API server.
   */

  /**
   * @typedef {Object} CacheValidator
   * @property {String} id - A unique identifier for the parameters of the request.
   * @property {Object} req - The request.
   */

  /**
   * @typedef {Object} CacheHook
   * @property {Function} req - Function that is fired with a {@link CacheValidator} as the only parameter before
   * performing the operation. When this function returns any value, the driver would return the
   * returned value by the function instead of querying the API server.
   * @property {Function} res - Function that is fired with a {@link CacheResult} as the only parameter once a result has
   * been grabbed from the API server.
   */

  /**
   * Adds a {@link CacheHook} to the driver pipeline.
   * @param {CacheHook} cacheHook - The {@link CacheHook} to use.
   */
  cache (cacheHook) {
    this._cache.push(cacheHook)
  }

  _localLogout () {
    if (!this._accessToken) {
      return
    }

    const user = this.userProfile
    this.setCredentials()
    this.emit('logout', user)
  }

  _sessionBeat () {
    clearTimeout(this._daemonSessionExpired)

    if (!this.accessToken || !this.userProfile || this.userProfile.sessionExpires <= Date.now()) {
      return this._localLogout()
    }

    this._daemonSessionExpired = setTimeout(this._sessionBeat.bind(this), Math.max(Math.round((this.userProfile.sessionExpires - Date.now()) * .75)), 1000)
  }

  _refreshCredentials () {
    // for redux
    this.token = this._accessToken
    this._userProfile = this._accessToken ? jwtDecode(this._accessToken) : null
    this._sessionBeat()

    if (!this._accessToken) {
      delete this._driver.defaults.headers.common['Authorization']
      return
    }

    this._driver.defaults.headers.common['Authorization'] = `Bearer ${ this._accessToken }`
    this.emit('login', this.userProfile)
  }

  get userProfile () {
    return this._userProfile
  }

  getSessionProfile () {
    return this._accessToken ? jwtDecode(this._accessToken) : null
  }

  /**
   * Obtaining accessToken and refreshToken.
   *
   * When called, any previous `accessToken` or `refreshToken` are cleared. The axios driver is used to hit the API server
   * with the given `credentials`.
   *
   * If succeed, the new received credentials are stored and used for authenticating further calls to the API server.
   *
   * @param {Object} credentials - Contains the user credentials that will be handled and validated by
   * the jwtAuthentication.loginMethod. See {@link ApiConfig}.
   * @param {Object} [params] - Params to add to the request (GET portion).
   *
   * @return {Promise<{accessToken, refreshToken}>} - Received accessToken and refreshToken
   *
   * @example
   *
   * import { PleasureClient } from 'pleasure'
   *
   * const pleasureClient = PleasureClient.instance()
   *
   * pleasureClient
   *   .login({ user: 'tin@devtin.io', password: 'mySuperStrongPassword123:)' })
   *   .then(({ accessToken, refreshToken }) => {
   *     console.log(`Authentication succeed with tokens >>>`, { accessToken, refreshToken })
   *     // maybe now the user could access protected routes
   *     // pleasureClient
   *     //   .list('users')
   *     //   .then(console.log)
   *   })
   */
  async login (credentials, params = {}) {
    this._localLogout()
    const { accessToken, refreshToken } = await this.driver({
      url: `${ this.config.authEndpoint }`,
      method: 'post',
      data: credentials,
      params
    })

    this.setCredentials({ accessToken, refreshToken })

    return {
      accessToken,
      refreshToken
    }
  }

  async me () {
    if (!this._accessToken) {
      return
    }
    // todo: hit and endpoint that blacklists the session
    await this._driver({
      url: `${ this.config.revokeEndpoint }`,
      method: 'post'
    })
    return this._localLogout()
  }

  get accessToken () {
    return this._accessToken
  }

  /**
   * Cleans client credentials obtained by {@link ApiClient#login}.
   */
  async logout () {
    // todo: hit and endpoint that blacklists the session
    await this._driver({
      url: `${ this.config.revokeEndpoint }`,
      method: 'post'
    })
    return this._localLogout()
  }

  /**
   * Creates `entry` into `entity`.
   *
   * @param {String} entity - The entity name.
   * @param {Object|Object[]} entry - The entry value. Alternatively, an array of objects to create multiple entries.
   * @param {Object} [params] - Params to add to the request (GET portion).
   * @return {Object|Object[]} - Resulted entry(s).
   * @throws {ApiError} -
   *
   * @example
   *
   * pleasureClient
   *   .create('product', {
   *     name: 'Gingerade Kombucha',
   *     price: 1.99,
   *     category: ['beverages', 'food', 'health', 'fitness'],
   *     stock: 12
   *   })
   *   .then(product => {
   *     console.log(product)
   *     // {
   *     //   id: '<someId>',
   *     //   name: 'Gingerade Kombucha',
   *     //   price: 1.99,
   *     //   category: ['beverages', 'food', 'health', 'fitness'],
   *     //   stock: 12
   *     // }
   *   })
   *
   * @example
   *
   * // Inserting multiple entries
   *
   * pleasureClient
   *   .create('product', [
   *     {
   *       name: 'Pomegranate Kombucha',
   *       price: 1.99,
   *       category: ['beverages', 'food', 'health', 'fitness'],
   *       stock: 8
   *     },
   *     {
   *       name: 'Cold Pressed Coconut Oil',
   *       price: 3.99,
   *       category: ['food'],
   *       stock: 12
   *     }
   *   ])
   *   .then(products => {
   *     assert.ok(Array.isArray(products))
   *     assert.equal(products.length, 2)
   *     console.log(products)
   *     // [
   *     //   {
   *     //     id: '<someId>',
   *     //     name: 'Pomegranate Kombucha',
   *     //     price: 1.99,
   *     //     category: ['beverages', 'food', 'health', 'fitness'],
   *     //     stock: 8
   *     //   },
   *     //   {
   *     //     id: '<someId>',
   *     //     name: 'Cold Pressed Coconut Oil',
   *     //     price: 3.99,
   *     //     category: ['food'],
   *     //     stock: 12
   *     //   }
   *     // ]
   *   })
   */
  create (entity, entry, params = {}) {
    if (!entity || !entry) {
      throw new Error(`Provide both entity and entry`)
    }

    return this.driver({
      url: `/${ entity }`,
      data: entry,
      method: 'post',
      params
    })
  }

  /**
   * Retrieves the Pleasure Entity Schema
   * @return {Object} - Pleasure Entity Schema
   */
  getEntities () {
    return this.driver({ url: this.config.entitiesUri })
  }

  /**
   * Reads entry `id` from `entity`. Optionally returns only the value found at `target`.
   *
   * @param {String} entity - The entity name.
   * @param {String} id - The entry id.
   * @param {String} [target] - Optionally return only the value at given target.
   * @param {Object} [params] - Params to add to the request (GET portion).
   * @return {*} - Matched entry.
   *
   * @example // Returning an entry
   *
   * pleasureClient
   *   .read('product', '<someId>')
   *   .then(product => {
   *     console.log(product)
   *     // {
   *     //   id: '<someId>',
   *     //   name: 'Gingerade Kombucha',
   *     //   price: 1.99,
   *     //   category: ['beverages', 'food', 'health', 'fitness'],
   *     //   stock: 12
   *     // }
   *   })
   *
   * @example // Returning a fragment of the entry
   *
   * pleasureClient
   *   .read('product', '<someId>', 'price')
   *   .then(price => {
   *     console.log(price)
   *     // 1.99
   *   })
   */
  read (entity, id, target, params = {}) {
    if (!entity || !id) {
      throw new Error(`Provide both entity and id`)
    }

    const endpoint = [entity, id, target].filter(p => !!p).join('/')
    const url = `/${ endpoint }`
    return this.driver({
      url,
      params
    })
  }

  /**
   * Partially updates entry `id` at `entity` with the information found at `update`.
   *
   * @param {String} entity - The entity name.
   * @param {String} id - The id of the entry.
   * @param {Object} update - Fields to be updated.
   * @param {Object} [params] - Params to add to the request (GET portion).
   * @return {*} - The updated entry.
   *
   * @example
   *
   * pleasureClient
   *   .update('product', '<someId>', { stock: 14 })
   *   .then(product => {
   *     console.log(product)
   *     // {
   *     //   id: '<someId>',
   *     //   name: 'Gingerade Kombucha',
   *     //   price: 1.99,
   *     //   category: ['beverages', 'food', 'health', 'fitness'],
   *     //   stock: 14
   *     // }
   *   })
   */
  update (entity, id, update, params) {
    if (!entity || !id) {
      throw new Error(`Provide both entity and id`)
    }

    return this.driver({
      url: `/${ entity }/${ id }`,
      method: 'patch',
      data: update,
      params
    })
  }

  /**
   * Lists entries in an entity.
   *
   * @param {String} entity - The entity name.
   * @param {Object} [options]
   * @param {Object} [options.sort] - Object containing fields belonging to the entity, with a numeric value:
   * 1 for ascending, -1 for descending. ie: `{ sort: { name: 1 } }` would sort entries ascending by the 'name' field.
   * @param {String} [options.search] - Full text search in the entity. See {@link https://docs.mongodb.com/manual/text-search/}
   * @param {Number} [options.limit] - Amount of entries to return. See `collectionListLimit` and `collectionMaxListLimit` in {@link ApiConfig}
   * @param {Number} [options.skip=0] - Entries to skip
   * @param {Object} [params={}] - Params to add to the request (GET portion).
   *
   * @example
   *
   * pleasureClient
   *   .list('product')
   *   .then(products => {
   *     console.log(`${products.length} products found`)
   *   })
   */
  list (entity, options = {}, params = {}) {
    if (!entity) {
      throw new Error(`Provide an entity`)
    }

    return this.driver({
      url: `/${ entity }`,
      params: Object.assign({}, params, options)
    })
  }

  /**
   * Deletes entry id from entity.
   *
   * @param {String} entity - Entity from where to remove the entry.
   * @param {Object|String|String[]} id - The `id` of the entry to delete. It can be an `Array` of id's, if we want
   * to delete multiple entries at once. It can also be an `Object` containing a mongoDB query for more complex removal
   * of entries.
   * @param {Object} [params] - Params to add to the request (GET portion).
   * @return {Object|Object[]} - The deleted entry. For multiple entries, it will be an `Array` containing the
   * deleted entries.
   *
   * @example Deleting a single entry
   *
   * pleasureClient
   *   .list('product')
   *   .then(products => {
   *     return pleasureClient.delete('product', products[0]._id)
   *   })
   *   .then(deletedProduct => {
   *     console.log(`Product ${deletedProduct.name} has been deleted`).
   *   })
   *
   * @example Deleting multiple entries by id
   *
   * pleasureClient
   *   .list('product')
   *   .then(products => {
   *     return pleasureClient.delete('product', products.map(({ _id }) => _id))
   *   })
   *   .then(deletedProducts => {
   *     deletedProducts.forEach(({ name }) => console.log(`Product ${name} has been deleted`))
   *   })
   *
   * @example Deleting using mongoDB queries
   *
   * pleasureClient
   *   .delete('product', { name: /kombucha/ })
   *   .then(productsDeleted => {
   *     console.log(`${productsDeleted.length} kombuchas were deleted.`)
   *   })
   */
  delete (entity, id, params = {}) {
    let url = `/${ entity }`

    // handle multiple ids
    if (typeof id === 'object') {
      Object.assign(params, { id: Array.isArray(id) ? castArray(id) : id })
      id = null
    }

    if (id) {
      url += `/${ id }`
    }

    return this.driver({
      url,
      method: 'delete',
      params
    })
  }

  /**
   * Pushes `push` value into the array found at `fieldPath`.
   *
   * @param {String} entity - The entity name.
   * @param {String} id - Id of the entry where to push the newEntry.
   * @param {String} fieldPath - Path to the field containing the Array where to push the value at `push`.
   * @param {String|Boolean|Number|Array|Object} push - Value to add to the array
   * @param {Boolean} [multiple=false] - If `push` is an array and `multiple` is set to `true`, the existing array found
   * at `fieldPath` will be concatenated with the given one.
   * @param {Object} [params] - Params to add to the request (GET portion).
   */
  push (entity, id, fieldPath, push, multiple = false, params = {}) {
    if (!entity || !id || !fieldPath || !push) {
      throw Error(`Provide all 'entity', 'id', 'fieldPath' and 'newEntry'.`)
    }
    return this.driver({
      url: `${ entity }/${ id }/${ fieldPath }`,
      method: 'post',
      data: { push, multiple },
      params
    })
  }

  controller (entity, controller, data = null, params) {
    if (!entity || !controller) {
      throw Error(`Provide both 'entity' and 'controller'.`)
    }

    const url = `${ entity }/${ controller }`

    return this.driver({
      url,
      method: data !== null ? 'post' : 'get',
      data,
      params
    })
  }

  /**
   * Pulls `pull` out of the array found at `fieldPath` from the entry `id` in `entity`.
   *
   * @param {String} entity - The entity name
   * @param {String} id - id of the entry where to push
   * @param {String} fieldPath - path to the field containing the Array
   * @param {String|String[]} pull - id(s) or value(s) to remove from the array.
   * existing array with the given one
   * @param {Object} [params] - Params to add to the request (GET portion).
   *
   * @example
   *
   * // Given the following product
   * // const productInDb = {
   * //   id: '<someId>',
   * //   name: 'Kombucha',
   * //   price: 1.99,
   * //   categories: ['beverages', 'food', 'health', 'fitness']
   * // }
   *
   * pleasureClient
   *   .pull('product', '<someId>', 'categories', ['food', 'fitness'])
   *   .then(product => {
   *     console.log(product)
   *     // {
   *     //   id: '<someId>',
   *     //   name: 'Kombucha',
   *     //   price: 1.99,
   *     //   categories: ['beverages', 'health']
   *     // }
   *   })
   */
  pull (entity, id, fieldPath, pull, params = {}) {
    if (!entity || !id || !fieldPath || !pull) {
      throw Error(`Provide all 'entity', 'id', 'fieldPath' and 'pull'.`)
    }
    return this.driver({
      url: `${ entity }/${ id }/${ fieldPath }`,
      method: 'delete',
      params: Object.assign({}, params, {
        pull
      })
    })
  }

  static instance (opts) {
    debug() && console.log(`pleasure-client-instance`, { opts })
    if (singleton) {
      if (opts && singleton._options && objectHash(opts) !== objectHash(singleton._options)) {
        throw new Error(`Singleton initialized.`)
      }
      return singleton
    }

    singleton = new ApiClient(opts)
    return singleton
  }
}

/**
 * Singleton instance of {@link ApiClient}.
 * @type {ApiClient}
 * @instance pleasureClient
 *
 * @example
 *
 * import { PleasureClient } from 'pleasure'
 * const pleasureClient = PleasureClient.instance()
 *
 * pleasureClient
 *   .list('products')
 *   .then(products => {
 *     console.log(`${products.length} products found.`)
 *   })
 *   .catch(err => {
 *     console.log(`Something went wrong: ${err.message}`)
 *   })
 */

const instance = ApiClient.instance.bind(ApiClient)

export { getDriver, ApiError, instance }
