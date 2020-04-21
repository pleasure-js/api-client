let _debug = false

export function debug (v) {
  if (v === undefined) {
    return _debug
  }
  return _debug = !!v
}
