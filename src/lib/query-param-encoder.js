import mapValues from 'lodash/mapValues'

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

export function queryParamEncode (obj) {
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
