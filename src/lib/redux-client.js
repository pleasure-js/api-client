import { debug } from './debug.js'
import merge from 'deepmerge'
import io from 'socket.io-client'
import url from 'url'
import { EventEmitter } from 'events'

export const defaultReduxOptions = {
  autoConnect: !!process.client
}

export class ReduxClient extends EventEmitter {
  /**
   *
   * @param {String} apiURL - URL to the API server
   * @param {Object} options
   * @param {Boolean} [options.autoConnect=true] - Whether to auto-connect to socket.io at init or not.
   */
  constructor (apiURL, options = {}) {
    super()
    options = merge.all([options, defaultReduxOptions, options])
    const { protocol, host, pathname } = url.parse(apiURL)
    this._options = options
    this._token = null
    this._isConnected = false
    this._isConnecting = false
    this._connectedAuth = null
    this._host = `${ protocol }//${ host }`
    this._path = pathname !== '/' ? pathname : null
    this._socketId = null

    this._socket = null

    this._binds = {
      error: this._error.bind(this),
      connect: this._connect.bind(this),
      disconnect: this._disconnect.bind(this),
      create: this._proxySocket.bind(this, 'create'),
      update: this._proxySocket.bind(this, 'update'),
      delete: this._proxySocket.bind(this, 'delete'),
      '*': (event, payload) => {
        debug() && console.log(`emit all`, { event, payload })
        this.emit('*', event, payload)
      }
    }

    if (this._options.autoConnect) {
      process.nextTick(() => {
        this.connect()
      })
    }
  }

  connect () {
    if (this._connectedAuth === this.token && (this._isConnected || this._isConnecting)) {
      debug() && console.log(`avoid connecting${ this._name ? ' ' + this._name : '' } due to this._connectedAuth === this.token = ${ this._connectedAuth === this.token } && this._isConnected = ${ this._isConnected } && this._isConnecting = ${ this._isConnecting })}`)
      return
    }

    this._isConnecting = true
    this._isConnected = false
    this._connectedAuth = this.token

    const auth = Object.assign({ forceNew: true, path: this._path }, this.token ? {
      transportOptions: {
        polling: {
          extraHeaders: {
            Authorization: `Bearer ${ this.token }`
          }
        }
      }
    } : {})

    if (this._socket) {
      debug() && this._socketId && console.log(`disconnecting from ${ this._socketId }`)
      this._unwireSocket()
      this._socket.disconnect(true)
    }

    debug() && console.log(`connecting${ this._name ? ' ' + this._name : '' } ${ this.token ? 'with' : 'without' } credentials to ${ this._host }`, { auth })
    const theSocket = io(this._host, auth)

    if (debug()) {
      theSocket.on('connect', () => {
        if (this._socket === theSocket) {
          this._socketId = theSocket.id
          debug() && console.log(`@pleasure-js/api-client${ this._name ? ' (' + this._name + ')' : '' } connected with id ${ theSocket.id }`)
        } else {
          debug() && console.log(`BEWARE! @pleasure-js/api-client${ this._name ? ' (' + this._name + ')' : '' } connected with id ${ theSocket.id } but not the main driver`)
        }
      })

      theSocket.on('disconnect', (reason) => {
        debug() && console.log(`@pleasure-js/api-client${ this._name ? ' (' + this._name + ')' : '' } disconnected due to ${ reason }`)
      })

      theSocket.on('reconnecting', (attemptNumber) => {
        debug() && console.log(`@pleasure-js/api-client${ this._name ? ' (' + this._name + ')' : '' } reconnecting attempt # ${ attemptNumber }`)
      })
    }

    theSocket.onevent = ReduxClient._onEvent(theSocket.onevent)

    this._socket = theSocket
    this._wireSocket()
  }

  static _onEvent (event) {
    return function (packet) {
      debug() && console.log(`receiving packet ${ packet }`)
      const args = packet.data || []
      event.call(this, packet)
      packet.data = ['*'].concat(args)
      event.call(this, packet)
    }
  }

  _wiring (methods, on = true, altMethod) {
    methods.forEach(method => {
      this._socket[on ? 'on' : 'off'](method, altMethod || this._binds[method])
    })
  }

  _unwireSocket () {
    this._wiring(Object.keys(this._binds), false)
    this._socket.removeAllListeners()
  }

  _wireSocket () {
    this._wiring(Object.keys(this._binds))
  }

  _proxySocket (method, payload) {
    debug() && console.log(`proxy socket`, { method, payload })
    this.emit(method, payload)
  }

  _error (...args) {
    this._isConnecting = false
    this.emit('error', ...args)
  }

  _connect () {
    debug() && console.log(`connected ${ this._socket.id }`)
    this._isConnected = true
    this._isConnecting = false
    this.emit('connect')
  }

  _disconnect (err) {
    debug() && console.log(`disconnected ${ this._socket.id }`)
    this._isConnected = false
    this.emit('disconnect')
  }

  get socket () {
    return this._socket
  }

  get token () {
    return this._token
  }

  set token (v) {
    this._token = v
    if (this._isConnected) {
      this.connect()
    }
    return v
  }
}
