import { ApiError } from './api-error'
import axios from 'axios'
import qs from 'qs'
import { debug } from './debug.js'
import get from 'lodash/get'

/**
 * Creates an axios instance able to handle API responses
 * @param {String} apiURL - URL of the API
 * @param {Number} [timeout] - Timeout in milliseconds
 * @return {Object} - axios instance
 */
export function getDriver ({ apiURL, timeout = 3000 }) {
  const driver = axios.create({
    timeout,
    baseURL: apiURL,
    paramsSerializer (params) {
      return qs.stringify(params, { arrayFormat: 'brackets' })
    },
    headers: {
      'X-Pleasure-Client': process.env.VERSION || 'edge'
    }
  })

  driver.interceptors.request.use((req) => {
      debug() && console.log(`api-client request`, req)
      return req
    }
  )

  driver.interceptors.response.use((response) => {
      // console.log({ response })
      const { data: { code = 500, data, error = { message: 'Unknown error', errors: [] } } } = response || {}

      if (code === 200) {
        return data
      }

      console.log(error.errors)

      throw new ApiError(error.message, code, error.errors)
    }/*,
    err => {
      console.log(`api error trapped`, err)
      throw err
    }*/
  )

  return driver
}

/**
 * Instance of getDriver using default values.
 * @type getDriver
 */
