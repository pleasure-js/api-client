import { ApiProxy } from './api-proxy.js'
import test from 'ava'

const proxy = ApiProxy()

test(`Interprets create method`, t => {
  const create = proxy.entities.user.create({
    name: 'my name'
  })

  t.is(create.url, '/entities/user')
  t.is(create.method, 'post')
  t.deepEqual(create.get, {})
  t.deepEqual(create.body, { name: 'my name' })

  const createAlt = new proxy.entities.user({
    name: 'my name'
  })

  t.is(createAlt.url, '/entities/user')
  t.is(createAlt.method, 'post')
  t.deepEqual(createAlt.get, {})
  t.deepEqual(createAlt.body, { name: 'my name' })
})

test(`Interprets read method`, async t => {
  const read = await proxy.entities.user({
    name: 'my name'
  })

  t.is(read.url, '/entities/user')
  t.is(read.method, 'get')
  t.deepEqual(read.get, { name: 'my name' })
  t.deepEqual(read.body, {})

  const readAlt = await proxy.entities.user('my-id')

  t.is(readAlt.url, '/entities/user/my-id')
  t.is(readAlt.method, 'get')
  t.deepEqual(readAlt.get, {})
  t.deepEqual(readAlt.body, {})
})

test(`Interprets update method`, t => {
  const update = proxy.entities.user({
    id: 'my-id'
  }).update({
    firstName: 'Martin'
  }) // => [PATCH] /entities/user => { name: 'my name' }

  t.is(update.url, '/entities/user')
  t.is(update.method, 'patch')
  t.deepEqual(update.get, { id: 'my-id' })
  t.deepEqual(update.body, {
    firstName: 'Martin'
  })
})

test(`Interprets delete method`, t => {
  const remove = proxy.entities.user({
    id: 'my-id'
  }).delete() // => [DELETE] /entities/user => { id: 'my-id' }

  t.is(remove.url, '/entities/user')
  t.is(remove.method, 'delete')
  t.deepEqual(remove.get, { id: 'my-id' })
  t.deepEqual(remove.body, {})

  const removeAlt = proxy.entities.user('my-id').delete() // => [DELETE] /entities/user/my-id

  t.is(removeAlt.url, '/entities/user/my-id')
  t.is(removeAlt.method, 'delete')
  t.deepEqual(removeAlt.get, {})
  t.deepEqual(removeAlt.body, {})
})

test(`Provides a middleware to trap the composed url`, async t => {
  const proxy = ApiProxy({
    next (serviceCall) {
      t.is(serviceCall.url, '/entities/user')
      t.is(serviceCall.method, 'get')
      t.deepEqual(serviceCall.get, { name: 'my name' })
      t.deepEqual(serviceCall.body, {})

      return 'value trapped'
    }
  })
  t.is(await proxy.entities.user({
    name: 'my name'
  }), 'value trapped')
})

test(`Provides a middleware to trap triggered methods`, async t => {
  const proxy = ApiProxy({
    methodCallback ({ method, args }) {
      return { method, args }
    }
  })
  t.is((await proxy.fetch({ url: 'papo' })).method, 'fetch')
})
