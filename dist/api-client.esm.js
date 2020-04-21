/*!
 * @pleasure-js/api-client v1.0.0
 * (c) 2018-2020 Martin Rafael Gonzalez <tin@devtin.io>
 * Released under the MIT License.
 */
import axios from 'axios';
import qs from 'qs';
import 'lodash/get';
import castArray from 'lodash/castArray';
import objectHash from 'object-hash';
import jwtDecode from 'jwt-decode';
import kebabCase from 'lodash/kebabCase';
import merge from 'deepmerge';
import io from 'socket.io-client';
import url from 'url';
import { EventEmitter } from 'events';
import mapValues from 'lodash/mapValues';

/**
 * Used to throw errors returned by the API server.
 * @see {@link https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Error|Error}
 */
class ApiError extends Error {
  /**
   *
   * @param {String} message
   * @param {Number} [code=500] - Error number.
   * @param data
   */
  constructor (message, code = 500, data) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

let _debug = false;

function debug (v) {
  if (v === undefined) {
    return _debug
  }
  return _debug = !!v
}

/**
 * Creates an axios instance able to handle API responses
 * @param {String} apiURL - URL of the API
 * @param {Number} [timeout] - Timeout in milliseconds
 * @return {Object} - axios instance
 */
function getDriver ({ apiURL, timeout = 3000 }) {
  const driver = axios.create({
    timeout,
    baseURL: apiURL,
    paramsSerializer (params) {
      return qs.stringify(params, { arrayFormat: 'brackets' })
    },
    headers: {
      'X-Pleasure-Client': "1.0.0" 
    }
  });

  driver.interceptors.request.use((req) => {
      debug() && console.log(`api-client request`, req);
      return req
    }
  );

  driver.interceptors.response.use((response) => {
      // console.log({ response })
      const { data: { code = 500, data, error = { message: 'Unknown error', errors: [] } } } = response || {};

      if (code === 200) {
        return data
      }

      console.log(error.errors);

      throw new ApiError(error.message, code, error.errors)
    }/*,
    err => {
      console.log(`api error trapped`, err)
      throw err
    }*/
  );

  return driver
}

/**
 * Instance of getDriver using default values.
 * @type getDriver
 */

/*
Initial handler
this one takes all calls to pleasureClient[:entity]
 */
const pathsToUrl = paths => {
  return `/` + paths.map(path => {
    if (typeof path === 'object') {
      return path.value
    }
    return kebabCase(path)
  }).join('/')
};

const deliverState = (state, { body = {}, query = {}, method = 'get' } = {}) => {
  const url = pathsToUrl(state.paths);
  state.paths.length = 0;
  return {
    url,
    method,
    get: query,
    body
  }
};

const handler = {
  construct (target, args) {
    // console.log(`constructor trap!`, ...args)
    return target.create(...args)
  },
  get (obj, prop) {
    if (Object.hasOwnProperty.call(obj, prop)) {
      return obj[prop]
    }
    obj.paths.push(prop);
    return obj.call(obj)
  },
  apply (target, thisArg, args) {
    if (target.paths.length === 1) {
      const method = target.paths[0];
      target.paths.length = 0;

      const res = target.methodCallback({ method, args });
      if (res !== undefined) {
        return res
      }

      target.paths.push(method);
    }
    target.get = args;
    return target.apply(thisArg, args)
  }
};

/**
 * Creates a proxy that translates all called properties->method into a URL
 * @example
 *
 * ```js
 * const proxy = ApiProxy()
 *
 * // CREATE
 * proxy.entities.user.create({
 *   name: 'my name'
 * }) // => [POST] /entities/user => { name: 'my name' }
 *
 * // READ
 * proxy.entities.user('123') // => [GET] /entities/user/123 => { name: 'my name' }
 *
 * // UPDATE
 * proxy.entities.user('123').update({
 *   name: 'my name'
 * }) // => [PATCH] /entities/user/123 => { name: 'my name' }
 *
 * proxy.entities.user({ created: { $gt: new Date('6/11/1983') } }).update({
 *   name: 'my name'
 * }) // => [PATCH] /entities/user?find={ created: { $gt: new Date('6/11/1983') } } => { name: 'my name' }
 *
 * proxy.entities.user.update({
 *   name: 'my name'
 * }) // => [PATCH] /entities/user => { name: 'my name' }
 *
 * // DELETE
 * proxy.entities.user({ inactive: { $eq: true } }).delete() // => [DELETE] /entities/user?find={ inactive: { $eq: true } }
 *
 * // LIST
 * proxy.user() // => [GET] /entities/user
 * proxy.user({ inactive: { $eq: false } }) // => [GET] /entities/user?find={ inactive: { $eq: false } }
 * ```
 */

function getCrudProxy ({ state, next, methodCallback }) {
  const crudProxy = function (query = {}) {
    if (typeof query !== 'object') {
      this.paths.push({ value: query });
      query = {};
    }
    return ApiProxy({
      state: {
        paths: this.paths,
        get: query
      },
      next,
      methodCallback
    })
  };

  crudProxy.methodCallback = methodCallback;
  crudProxy.valueOf = crudProxy.toString = function () {
    return deliverState(this, { query: this.get })
  };

  crudProxy.then = function (fn) {
    return fn(next(crudProxy.valueOf()))
  };

  crudProxy.create = function (body) {
    return next(deliverState(this, { body, method: 'post' }))
  };
  crudProxy.update = function (body) {
    return next(deliverState(this, { method: 'patch', body, query: this.get }))
  };
  crudProxy.delete = function () {
    if (arguments.length > 0) {
      throw new Error(`Method delete does not take any arguments`)
    }
    return next(deliverState(this, { method: 'delete', query: this.get }))
  };
  Object.assign(crudProxy, state);
  return crudProxy
}

function ApiProxy ({ state = {}, next = r => r, methodCallback = r => r } = {}) {
  state = getCrudProxy({ state, next, methodCallback });
  if (!state.paths) {
    state.paths = [];
  }

  return new Proxy(state, handler)
}

const defaultReduxOptions = {
  autoConnect: !!true
};

class ReduxClient extends EventEmitter {
  /**
   *
   * @param {String} apiURL - URL to the API server
   * @param {Object} options
   * @param {Boolean} [options.autoConnect=true] - Whether to auto-connect to socket.io at init or not.
   */
  constructor (apiURL, options = {}) {
    super();
    options = merge.all([options, defaultReduxOptions, options]);
    const { protocol, host, pathname } = url.parse(apiURL);
    this._options = options;
    this._token = null;
    this._isConnected = false;
    this._isConnecting = false;
    this._connectedAuth = null;
    this._host = `${ protocol }//${ host }`;
    this._path = pathname !== '/' ? pathname : null;
    this._socketId = null;

    this._socket = null;

    this._binds = {
      error: this._error.bind(this),
      connect: this._connect.bind(this),
      disconnect: this._disconnect.bind(this),
      create: this._proxySocket.bind(this, 'create'),
      update: this._proxySocket.bind(this, 'update'),
      delete: this._proxySocket.bind(this, 'delete'),
      '*': (event, payload) => {
        debug() && console.log(`emit all`, { event, payload });
        this.emit('*', event, payload);
      }
    };

    if (this._options.autoConnect) {
      process.nextTick(() => {
        this.connect();
      });
    }
  }

  connect () {
    if (this._connectedAuth === this.token && (this._isConnected || this._isConnecting)) {
      debug() && console.log(`avoid connecting${ this._name ? ' ' + this._name : '' } due to this._connectedAuth === this.token = ${ this._connectedAuth === this.token } && this._isConnected = ${ this._isConnected } && this._isConnecting = ${ this._isConnecting })}`);
      return
    }

    this._isConnecting = true;
    this._isConnected = false;
    this._connectedAuth = this.token;

    const auth = Object.assign({ forceNew: true, path: this._path }, this.token ? {
      transportOptions: {
        polling: {
          extraHeaders: {
            Authorization: `Bearer ${ this.token }`
          }
        }
      }
    } : {});

    if (this._socket) {
      debug() && this._socketId && console.log(`disconnecting from ${ this._socketId }`);
      this._unwireSocket();
      this._socket.disconnect(true);
    }

    debug() && console.log(`connecting${ this._name ? ' ' + this._name : '' } ${ this.token ? 'with' : 'without' } credentials to ${ this._host }`, { auth });
    const theSocket = io(this._host, auth);

    if (debug()) {
      theSocket.on('connect', () => {
        if (this._socket === theSocket) {
          this._socketId = theSocket.id;
          debug() && console.log(`@pleasure-js/api-client${ this._name ? ' (' + this._name + ')' : '' } connected with id ${ theSocket.id }`);
        } else {
          debug() && console.log(`BEWARE! @pleasure-js/api-client${ this._name ? ' (' + this._name + ')' : '' } connected with id ${ theSocket.id } but not the main driver`);
        }
      });

      theSocket.on('disconnect', (reason) => {
        debug() && console.log(`@pleasure-js/api-client${ this._name ? ' (' + this._name + ')' : '' } disconnected due to ${ reason }`);
      });

      theSocket.on('reconnecting', (attemptNumber) => {
        debug() && console.log(`@pleasure-js/api-client${ this._name ? ' (' + this._name + ')' : '' } reconnecting attempt # ${ attemptNumber }`);
      });
    }

    theSocket.onevent = ReduxClient._onEvent(theSocket.onevent);

    this._socket = theSocket;
    this._wireSocket();
  }

  static _onEvent (event) {
    return function (packet) {
      debug() && console.log(`receiving packet ${ packet }`);
      const args = packet.data || [];
      event.call(this, packet);
      packet.data = ['*'].concat(args);
      event.call(this, packet);
    }
  }

  _wiring (methods, on = true, altMethod) {
    methods.forEach(method => {
      this._socket[on ? 'on' : 'off'](method, altMethod || this._binds[method]);
    });
  }

  _unwireSocket () {
    this._wiring(Object.keys(this._binds), false);
    this._socket.removeAllListeners();
  }

  _wireSocket () {
    this._wiring(Object.keys(this._binds));
  }

  _proxySocket (method, payload) {
    debug() && console.log(`proxy socket`, { method, payload });
    this.emit(method, payload);
  }

  _error (...args) {
    this._isConnecting = false;
    this.emit('error', ...args);
  }

  _connect () {
    debug() && console.log(`connected ${ this._socket.id }`);
    this._isConnected = true;
    this._isConnecting = false;
    this.emit('connect');
  }

  _disconnect (err) {
    debug() && console.log(`disconnected ${ this._socket.id }`);
    this._isConnected = false;
    this.emit('disconnect');
  }

  get socket () {
    return this._socket
  }

  get token () {
    return this._token
  }

  set token (v) {
    this._token = v;
    if (this._isConnected) {
      this.connect();
    }
    return v
  }
}

/**
 * Deeply scans and encodes complex objects to be sent via query params to the controller.
 *
 * - Converts regex values into { $regex, $options } for mongoDB purposes
 *
 * @param {Object} obj - The object to encode
 * @return {Object} - Encoded object
 *
 * @example
 *
 * console.log(PleasureClient.queryParamEncode({ email: /@gmail.com$/i }))
 * // { email: { $regex: '@gmail.com', $options: 'i' } }
 */

function queryParamEncode (obj) {
  return mapValues(obj, o => {
    if (Array.isArray(o)) {
      return o
    }

    if (o instanceof RegExp) {
      return { $regex: o.source, $options: o.flags }
    }

    if (typeof o === 'object') {
      return queryParamEncode(o)
    }

    // temporary fix for listing with double quotes
    return JSON.stringify(o)
  })
}

Promise.each = async function (arr, fn) { // take an array and a function
  for (const item of arr) await fn(item);
};

let singleton;

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
class ApiClient extends ReduxClient {
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
    const { apiURL, timeout } = options.config;
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
    } = options;

    debug() && console.log(`initializing @pleasure-js/api-client`, { reduxOptions });
    const { baseURL } = driver.defaults;
    super(baseURL, reduxOptions);

    const { accessToken, refreshToken } = Object.assign(this.savedCredentials(), options);

    this._autoLoadCredentials = autoLoadCredentials;
    this._options = options;
    this._name = options.name;
    this._driver = driver;
    this._userProfile = null;
    this._daemonSessionExpired = null;
    this._cache = [];
    this.config = config;
    this._storeCredentials = storeCredentials;
    this._credentialsStorage = credentialsStorage;
    this._credentialsStorageName = credentialsStorageName;

    this.setCredentials({ accessToken, refreshToken });

    // return new Proxy(this, handler)
    const $this = this;
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
    const credentials = {};
    if (this._storeCredentials && true) {
      Object.assign(credentials, JSON.parse(window[this._credentialsStorage].getItem(this._credentialsStorageName) || '{}'));
    }
    // console.log(`credentials saved`, credentials)
    return credentials
  }

  static debug (v) {
    return debug(v)
  }

  setCredentials ({ accessToken = null, refreshToken = null } = {}) {
    if (this._storeCredentials && true) {
      window[this._credentialsStorage].setItem(this._credentialsStorageName, JSON.stringify({
        accessToken,
        refreshToken
      }));
    }
    this._accessToken = accessToken;
    this._refreshToken = refreshToken;

    // important in order to set authorization via constructor
    this._refreshCredentials();
  }

  async proxyCacheReq ({ id, req }) {
    let res;
    await Promise.each(this._cache, async (CacheHook) => {
      res = await CacheHook.req({ id, req });
      if (typeof res !== 'undefined') {
        return false
      }
    });
    return res
  }

  async proxyCacheRes ({ id, req, res }) {
    await Promise.each(this._cache, async (CacheHook) => {
      await CacheHook.res({ id, req, res });
    });

    return res
  }

  async driver (req = {}) {
    const id = objectHash(req);
    const cache = await this.proxyCacheReq({ id, req });

    if (req.params) {
      req.params = queryParamEncode(req.params);
    }

    if (typeof cache !== 'undefined') {
      return cache
    }

    debug() && console.log(`@pleasure-js/api-client calling>`, { req }, `${ this.accessToken ? 'with auth' : ' without auth' }`);
    const res = await this._driver(req);

    this
      .proxyCacheRes({ id, req, res })
      .catch(err => {
        console.log(`Proxy cache res error:`, err);
      });

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
    this._cache.push(cacheHook);
  }

  _localLogout () {
    if (!this._accessToken) {
      return
    }

    const user = this.userProfile;
    this.setCredentials();
    this.emit('logout', user);
  }

  _sessionBeat () {
    clearTimeout(this._daemonSessionExpired);

    if (!this.accessToken || !this.userProfile || this.userProfile.sessionExpires <= Date.now()) {
      return this._localLogout()
    }

    this._daemonSessionExpired = setTimeout(this._sessionBeat.bind(this), Math.max(Math.round((this.userProfile.sessionExpires - Date.now()) * .75)), 1000);
  }

  _refreshCredentials () {
    // for redux
    this.token = this._accessToken;
    this._userProfile = this._accessToken ? jwtDecode(this._accessToken) : null;
    this._sessionBeat();

    if (!this._accessToken) {
      delete this._driver.defaults.headers.common['Authorization'];
      return
    }

    this._driver.defaults.headers.common['Authorization'] = `Bearer ${ this._accessToken }`;
    this.emit('login', this.userProfile);
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
    this._localLogout();
    const { accessToken, refreshToken } = await this.driver({
      url: `${ this.config.authEndpoint }`,
      method: 'post',
      data: credentials,
      params
    });

    this.setCredentials({ accessToken, refreshToken });

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
    });
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
    });
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

    const endpoint = [entity, id, target].filter(p => !!p).join('/');
    const url = `/${ endpoint }`;
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
    let url = `/${ entity }`;

    // handle multiple ids
    if (typeof id === 'object') {
      Object.assign(params, { id: Array.isArray(id) ? castArray(id) : id });
      id = null;
    }

    if (id) {
      url += `/${ id }`;
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

    const url = `${ entity }/${ controller }`;

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
    debug() && console.log(`pleasure-client-instance`, { opts });
    if (singleton) {
      if (opts && singleton._options && objectHash(opts) !== objectHash(singleton._options)) {
        throw new Error(`Singleton initialized.`)
      }
      return singleton
    }

    singleton = new ApiClient(opts);
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

const instance = ApiClient.instance.bind(ApiClient);

export { ApiClient, ApiError, getDriver, instance };
