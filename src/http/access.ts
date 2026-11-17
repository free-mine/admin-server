import type { IncomingHttpHeaders } from 'node:http'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

import type { Session } from './types.js'
import { AppError } from '../shared/index.js'

const sessionSeconds = 12 * 60 * 60
const attemptWindowMs = 15 * 60 * 1000
const cookieName = 'panel_session'

export class Access {
  private sessions = new Map<string, Session>()
  private pinHash: Buffer
  private failures = 0
  private retryAt = 0

  constructor(
    private domain: string,
    pin: string,
  ) {
    this.pinHash = createHash('sha256').update(pin).digest()
  }

  allows(headers: IncomingHttpHeaders): boolean {
    const host = headers.host
    if (!host || !/^[a-zA-Z0-9.-]+(?::[0-9]{1,5})?$/.test(host)) {
      return false
    }
    try {
      if (
        host.split(':')[0].toLowerCase() !== this.domain ||
        new URL(`http://${host}`).hostname !== this.domain
      ) {
        return false
      }
      const origin = headers.origin
      if (origin === undefined) {
        return true
      }
      const url = new URL(origin)
      return (
        (url.protocol === 'http:' || url.protocol === 'https:') &&
        url.hostname === this.domain &&
        url.origin === origin
      )
    } catch {
      return false
    }
  }

  session(cookie?: string): Session | undefined {
    const values = cookie
      ?.split(';')
      .map(value => value.trim())
      .filter(value => value.startsWith(`${cookieName}=`))
    if (values?.length !== 1) {
      return undefined
    }
    return this.get(values[0].slice(cookieName.length + 1))
  }

  get(token: string): Session | undefined {
    const session = this.sessions.get(token)
    if (session && session.expiresAt <= Date.now()) {
      this.sessions.delete(token)
      return undefined
    }
    return session
  }

  login(pin: string, cookie?: string): Session {
    const now = Date.now()
    if (now >= this.retryAt) {
      this.failures = 0
      this.retryAt = now + attemptWindowMs
    }
    if (this.failures >= 5) {
      throw new AppError('AUTH_RATE_LIMITED', 429)
    }
    const candidate = createHash('sha256').update(pin).digest()
    if (!timingSafeEqual(candidate, this.pinHash)) {
      this.failures += 1
      throw new AppError('INVALID_PIN', 401)
    }
    this.failures = 0
    this.logout(cookie)
    for (const [token, session] of this.sessions) {
      if (session.expiresAt <= now) {
        this.sessions.delete(token)
      }
    }
    // Bound memory even when a client repeatedly signs in without a cookie.
    for (const token of this.sessions.keys()) {
      if (this.sessions.size < 100) {
        break
      }
      this.sessions.delete(token)
    }
    const session = {
      token: randomBytes(32).toString('base64url'),
      expiresAt: now + sessionSeconds * 1000,
    }
    this.sessions.set(session.token, session)
    return session
  }

  logout(cookie?: string) {
    const session = this.session(cookie)
    if (session) {
      this.sessions.delete(session.token)
    }
  }

  cookie(session: Session | undefined, secure: boolean): string {
    return `${cookieName}=${session?.token ?? ''}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${session ? sessionSeconds : 0}${secure ? '; Secure' : ''}`
  }
}
