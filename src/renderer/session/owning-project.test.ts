import { describe, expect, it } from 'vitest'
import { spawnBelongsElsewhere } from './owning-project'

// The create-time half of bug F's defense (F2c): a node of a REMOTE project (a hosted team / relay
// tab) that finds itself under a session which is not a relay session must start nothing — that
// session is this desktop's own core, and the node id belongs to the host.
describe('spawnBelongsElsewhere', () => {
  it('a remote project under a non-relay session belongs elsewhere', () => {
    expect(spawnBelongsElsewhere({ remote: true }, 'local')).toBe(true)
    expect(spawnBelongsElsewhere({ remote: true }, 'server')).toBe(true)
  })

  it('a remote project under a relay session is where it belongs', () => {
    expect(spawnBelongsElsewhere({ remote: true }, 'relay')).toBe(false)
  })

  it('a local project never belongs elsewhere, whatever the session', () => {
    expect(spawnBelongsElsewhere({}, 'local')).toBe(false)
    expect(spawnBelongsElsewhere({ remote: false }, 'local')).toBe(false)
    expect(spawnBelongsElsewhere({}, 'relay')).toBe(false)
    expect(spawnBelongsElsewhere({}, 'server')).toBe(false)
  })

  it('an unknown project is not evidence of anything', () => {
    expect(spawnBelongsElsewhere(undefined, 'local')).toBe(false)
    expect(spawnBelongsElsewhere(undefined, 'relay')).toBe(false)
  })
})
