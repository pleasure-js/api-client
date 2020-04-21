const { name: packageName, version, author, peerDependencies: external, dependencies: only } = require('./package.json')
const minify = require('rollup-plugin-babel-minify')
const commonjs = require('rollup-plugin-commonjs')
const nodeResolve = require('rollup-plugin-node-resolve')
const json = require('rollup-plugin-json')
const rollupBuiltins = require('rollup-plugin-node-builtins')
const rollupReplace = require('rollup-plugin-replace')
const merge = require('deepmerge')
const { getConfig: getApiConfig, getPlugins: getApiPlugins } = require('@pleasure-js/utils-v2')
const { config: { http: { port }, entities: { prefix: entitiesUri }, api: { prefix } } } = getApiConfig()
// const { pluginsConfig: { jwt: { authEndpoint, revokeEndpoint } } } = getApiPlugins()
const fs = require('fs')
const path = require('path')

const banner = `/*!
 * ${ packageName } v${ version }
 * (c) 2018-${ new Date().getFullYear() } ${ author }
 * Released under the MIT License.
 */`

const getPlugins = ({ minified = false, bundle = false, replace = {} } = {}) => {
  const plugs = [
    rollupReplace(Object.assign({
      VERSION: JSON.stringify(version),
      DEF_API_PORT: JSON.stringify(port),
      DEF_API_PREFIX: JSON.stringify(prefix),
      // DEF_API_AUTH_ENDPOINT: JSON.stringify(authEndpoint),
      // DEF_API_REVOKE_ENDPOINT: JSON.stringify(revokeEndpoint),
      DEF_API_ENTITIES_URI: JSON.stringify(entitiesUri)
    }, replace)),
    json()
  ]

  if (bundle) {
    const externals = []
    // objectHash
    externals.push(fs.readFileSync(require.resolve('object-hash/dist/object_hash.js')).toString())
    // axios
    externals.push(fs.readFileSync(require.resolve('axios/dist/axios.js')).toString())
    // socket.io-client
    externals.push(fs.readFileSync(require.resolve('socket.io-client/dist/socket.io.js')).toString())
    // socket.io-client
    // externals.push(fs.readFileSync(require.resolve('socket.io-client/dist/socket.io.js')).toString())

    fs.writeFileSync(path.join(__dirname, './dist/api-client-deps.js'), externals.join(`\n`))

    // console.log({ prepend })
    plugs.push(
      // rollupInsert.prepend(prepend),
      rollupBuiltins({
        crypto: true
      }),
      nodeResolve({
        jsnext: true,
        main: true,
        browser: true,
        only: ['lodash', 'qs', 'jwt-decode', 'deepmerge', 'url', 'object-hash']
      }),
      commonjs()
    )
  }

  if (minified) {
    plugs.push(minify(merge({
      comments: false,
      bannerNewLine: true
    }, typeof minified === 'object' ? minified : {})))
  }

  return plugs
}

const envReplace = {
  'process.env.API_ERROR': JSON.stringify(false),
  'process.server': false,
  'process.client': true,
  'process.env.VERSION': JSON.stringify(version),
  'process.env.PLEASURE_CLIENT_APP_URL': null,
  'process.env.PLEASURE_CLIENT_APP_SERVER_URL': null,
  'process.env.PLEASURE_MODE': null,
  'process.env.PLEASURE_CLIENT_API_URL': null,
  'process.env.PLEASURE_CLIENT_ENTITIES_URI': null,
  'process.env.PLEASURE_CLIENT_AUTH_ENDPOINT': null,
  'process.env.PLEASURE_CLIENT_REVOKE_ENDPOINT': null
}

const plugins = getPlugins({ replace: envReplace })
const name = 'ApiClient'

module.exports = [
  {
    input: 'src/api-client.js',
    output: [
      {
        file: 'dist/api-client.common.js',
        format: 'cjs',
        banner
      },
      {
        file: 'dist/api-client.esm.js',
        format: 'esm',
        banner
      }
    ],
    plugins
  },
  {
    input: 'src/api-client.js',
    output: [
      {
        file: 'dist/api-client.js',
        name,
        format: 'iife',
        banner
      }
    ],
    plugins: getPlugins({
      bundle: true,
      replace: envReplace
    })
  },
  {
    input: 'src/api-client.js',
    // external: ['crypto'],
    output: [
      {
        file: 'dist/api-client.min.js',
        name,
        format: 'iife',
        banner
      },
    ],
    plugins: getPlugins({
      bundle: true,
      minified: true,
      replace: envReplace
    })
  },
]
