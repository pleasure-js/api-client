import { ApiClient } from './api-client.js'
import test from 'ava'

test(`Calls the driver`, async t => {
  ApiClient.prototype.driver = function (config) {
    t.is(config.url, '/entities/user/123')
    t.is(config.method, 'patch')
    t.deepEqual(config.params, {})
    t.deepEqual(config.data, { name: 'Martin' })
    return { data: 'success' }
  }
  const client = new ApiClient({
    config: { 
      apiURL: 'http://localhost:3000',
      timeout: 3000
    }
  })
  t.deepEqual((await client.entities.user(123).update({ name: 'Martin' })), { data: 'success' })
})
