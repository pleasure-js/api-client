import kebabCase from 'lodash/kebabCase'

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
}

const deliverState = (state, { body = {}, query = {}, method = 'get' } = {}) => {
  const url = pathsToUrl(state.paths)
  state.paths.length = 0
  return {
    url,
    method,
    get: query,
    body
  }
}

const handler = {
  construct (target, args) {
    // console.log(`constructor trap!`, ...args)
    return target.create(...args)
  },
  get (obj, prop) {
    if (Object.hasOwnProperty.call(obj, prop)) {
      return obj[prop]
    }
    obj.paths.push(prop)
    return obj.call(obj)
  },
  apply (target, thisArg, args) {
    if (target.paths.length === 1) {
      const method = target.paths[0]
      target.paths.length = 0

      const res = target.methodCallback({ method, args })
      if (res !== undefined) {
        return res
      }

      target.paths.push(method)
    }
    target.get = args
    return target.apply(thisArg, args)
  }
}

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
      this.paths.push({ value: query })
      query = {}
    }
    return ApiProxy({
      state: {
        paths: this.paths,
        get: query
      },
      next,
      methodCallback
    })
  }

  crudProxy.methodCallback = methodCallback
  crudProxy.valueOf = crudProxy.toString = function () {
    return deliverState(this, { query: this.get })
  }

  crudProxy.then = function (fn) {
    return fn(next(crudProxy.valueOf()))
  }

  crudProxy.create = function (body) {
    return next(deliverState(this, { body, method: 'post' }))
  }
  crudProxy.update = function (body) {
    return next(deliverState(this, { method: 'patch', body, query: this.get }))
  }
  crudProxy.delete = function () {
    if (arguments.length > 0) {
      throw new Error(`Method delete does not take any arguments`)
    }
    return next(deliverState(this, { method: 'delete', query: this.get }))
  }
  Object.assign(crudProxy, state)
  return crudProxy
}

export function ApiProxy ({ state = {}, next = r => r, methodCallback = r => r } = {}) {
  state = getCrudProxy({ state, next, methodCallback })
  if (!state.paths) {
    state.paths = []
  }

  return new Proxy(state, handler)
}
