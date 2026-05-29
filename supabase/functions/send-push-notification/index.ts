import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.100.0'
import { buildPushEnvelope, buildPushDedupKey, getPushDedupWindowMs } from '../_shared/pushNotifications.ts'
import { getPushCopy, resolvePushCopyLanguage } from '../_shared/pushCopy.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const APNS_HOSTS = {
  sandbox: 'https://api.sandbox.push.apple.com',
  production: 'https://api.push.apple.com',
} as const

const SAFE_PUSH_COPY_FALLBACKS: Record<string, { title: string; body: string }> = {
  new_dispatch_offer: {
    title: 'New request nearby',
    body: 'A new customer is looking for help right now.',
  },
}

type ApnsEnvironment = keyof typeof APNS_HOSTS

/**
 * send-push-notification
 *
 * Sends an APNs push notification to all walkers (or a specific user).
 * Also creates in-app notification records for broadcast notifications
 * (new job requests sent to all online walkers).
 *
 * Request body:
 *   { title, body, targetUserId?, data?, createInAppNotification?, badge? }
 *
 * If targetUserId is omitted, sends to ALL online walker push tokens
 * AND creates in-app notifications for all online walkers.
 */
serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    const apnsPrivateKey = Deno.env.get('APNS_PRIVATE_KEY')
    const apnsKeyId = Deno.env.get('APNS_KEY_ID')
    const apnsTeamId = Deno.env.get('APNS_TEAM_ID')
    const apnsBundleId = Deno.env.get('APNS_BUNDLE_ID')
    const apnsEnvironment = getApnsEnvironment(Deno.env.get('APNS_ENVIRONMENT'))
    const hasApnsConfig = !!(
      apnsPrivateKey &&
      apnsKeyId &&
      apnsTeamId &&
      apnsBundleId
    )

    if (!supabaseUrl || !serviceRoleKey) {
      return jsonResp({ error: 'Server misconfigured (supabase)' }, 500)
    }

    const authHeader = req.headers.get('Authorization')
    const internalAuthHeader = `Bearer ${serviceRoleKey}`
    const isInternalServiceCall = authHeader === internalAuthHeader

    if (!authHeader) {
      return jsonResp({ error: 'Missing authorization' }, 401)
    }

    if (!isInternalServiceCall) {
      const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY') || ''
      const supabaseUser = createClient(supabaseUrl, supabaseAnonKey, {
        global: { headers: { Authorization: authHeader } },
      })
      const { data: { user }, error: authError } = await supabaseUser.auth.getUser()
      if (authError || !user) {
        return jsonResp({ error: 'Invalid token' }, 401)
      }
    }

    let body: {
      title?: string
      body?: string
      targetUserId?: string
      data?: Record<string, string | number | boolean | null | undefined>
      badge?: number
      createInAppNotification?: boolean
      inAppType?: string
      inAppTitle?: string
      inAppMessage?: string
      notificationType?: string
      relatedJobId?: string
      deepLink?: string
    }
    try {
      body = await req.json()
    } catch {
      return jsonResp({ error: 'Invalid request body' }, 400)
    }

    const { title, body: notifBody, targetUserId, data: notifData } = body

    const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey)
    const appLanguage = readString(notifData?.appLanguage) ?? readString(notifData?.app_language) ?? null
    const payloadProfileLanguage = readString(notifData?.profileLanguage) ?? readString(notifData?.profile_language) ?? null
    const notificationType =
      body.notificationType ?? body.inAppType ?? readString(notifData?.type) ?? 'new_request'
    const languageResolution = targetUserId
      ? await resolveTargetUserLanguage({
          supabaseAdmin,
          targetUserId,
          payloadProfileLanguage,
          appLanguage,
        })
      : {
          resolvedLanguage: resolvePushCopyLanguage(payloadProfileLanguage, appLanguage),
          source: payloadProfileLanguage ? 'profile' : appLanguage ? 'fallback' : 'fallback',
        }
    const resolvedLanguage = languageResolution.resolvedLanguage
    console.log(`[Push] targetUserId=${targetUserId ?? '<broadcast>'}`)
    console.log(`[Push] resolvedLanguage=${resolvedLanguage}`)
    console.log(`[Push] source=${languageResolution.source}`)
    console.log(`[Push] notificationType=${notificationType}`)

    const safeEnglishCopy = SAFE_PUSH_COPY_FALLBACKS[notificationType] ?? {
      title: 'Notification',
      body: 'Open Regli for details.',
    }

    let localizedCopy: ReturnType<typeof getPushCopy> = null
    try {
      localizedCopy = getPushCopy(notificationType, {
        language: resolvedLanguage,
        providerName: readString(notifData?.providerName) ?? readString(notifData?.provider_name) ?? null,
        walkerName: readString(notifData?.walkerName) ?? readString(notifData?.walker_name) ?? null,
        amountText: readString(notifData?.amountText) ?? readString(notifData?.amount_text) ?? null,
        serviceType: readString(notifData?.serviceType) ?? readString(notifData?.service_type) ?? null,
      })
    } catch {
      localizedCopy = null
    }

    const hasLocalizedCopy = !!(localizedCopy?.title?.trim() && localizedCopy?.body?.trim())
    if (hasLocalizedCopy) {
      console.log('[Push] localized copy resolved')
    } else {
      console.log('[Push] localized copy fallback used')
    }

    const effectiveTitle =
      readString(title) ??
      readString(localizedCopy?.title) ??
      safeEnglishCopy.title
    const effectiveBody =
      readString(notifBody) ??
      readString(localizedCopy?.body) ??
      safeEnglishCopy.body

    const envelope = buildPushEnvelope({
      type: notificationType,
      title: effectiveTitle,
      body: effectiveBody,
      relatedJobId: body.relatedJobId ?? readString(notifData?.jobId) ?? readString(notifData?.related_job_id) ?? null,
      deepLink: body.deepLink ?? readString(notifData?.deepLink) ?? readString(notifData?.deep_link) ?? null,
      dedupId: readString(notifData?.dedupId) ?? readString(notifData?.dedup_id) ?? null,
    })
    const dedupKey = buildPushDedupKey(envelope)
    const dedupWindowMs = getPushDedupWindowMs(envelope.type)

    let walkerIds: string[] = []

    let query = supabaseAdmin
      .from('push_tokens')
      .select('token, user_id, platform')
      .eq('enabled', true)

    if (targetUserId) {
      query = query.eq('user_id', targetUserId)
    } else {
      const { data: walkers } = await supabaseAdmin
        .from('profiles')
        .select('id')
        .eq('role', 'walker')
        .eq('is_online', true)

      if (!walkers || walkers.length === 0) {
        return jsonResp({ sent: 0, message: 'No walkers found' }, 200)
      }

      walkerIds = walkers.map((w: { id: string }) => w.id)
      query = query.in('user_id', walkerIds)

      const jobId = envelope.related_job_id
      const inAppType = body.inAppType || envelope.type || 'new_request'
      const inAppTitle = body.inAppTitle || effectiveTitle
      const inAppMessage = body.inAppMessage || effectiveBody

      const notifRows = walkerIds.map((wId) => ({
        user_id: wId,
        type: inAppType,
        title: inAppTitle,
        message: inAppMessage,
        related_job_id: jobId,
        is_read: false,
      }))

      if (notifRows.length > 0) {
        const { error: insertErr } = await supabaseAdmin
          .from('notifications')
          .insert(notifRows)

        if (insertErr) {
          console.error('[Push] Failed to create in-app notifications:', insertErr.message)
        } else {
          console.log(`[Push] Created ${notifRows.length} in-app notification(s) for online walkers`)
        }
      }
    }

    const { data: tokens, error: tokensErr } = await query
    if (tokensErr) {
      console.error('Failed to fetch tokens:', tokensErr)
      return jsonResp({ error: 'Failed to fetch tokens' }, 500)
    }

    if (!tokens || tokens.length === 0) {
      return jsonResp({
        ok: true,
        sent: 0,
        notified: walkerIds.length,
        skipped: hasApnsConfig ? null : 'apns_not_configured',
        message: 'No push tokens found (in-app notifications still created)',
      }, 200)
    }

    const iosTokens = tokens.filter(({ platform }) => platform === 'ios')

    if (iosTokens.length === 0) {
      return jsonResp({
        ok: true,
        sent: 0,
        total: tokens.length,
        iosTotal: 0,
        notified: walkerIds.length,
        skipped: 'no_ios_tokens',
      }, 200)
    }

    if (!hasApnsConfig) {
      console.warn('[Push] APNs not configured; skipping remote push delivery')
      return jsonResp({
        ok: true,
        sent: 0,
        total: tokens.length,
        iosTotal: iosTokens.length,
        notified: walkerIds.length,
        skipped: 'apns_not_configured',
      }, 200)
    }

    const apnsJwt = await createApnsJwt(apnsPrivateKey, apnsKeyId, apnsTeamId)
    const apnsHost = APNS_HOSTS[apnsEnvironment]
    const staleTokens: string[] = []
    let sentCount = 0
    const badge = Number.isFinite(body.badge) ? Number(body.badge) : undefined

    const normalizedData = buildNormalizedPushData({
      envelope,
      dedupKey,
      dedupWindowMs,
      data: notifData,
    })

    for (const { token, user_id } of iosTokens) {
      try {
        console.log(`[Push] sending APNS to targetUserId=${user_id}`)
        const payload: Record<string, unknown> = {
          aps: {
            alert: { title: effectiveTitle, body: effectiveBody },
            sound: 'default',
            ...(badge !== undefined ? { badge } : {}),
          },
          data: normalizedData,
        }

        const res = await fetch(`${apnsHost}/3/device/${token}`, {
          method: 'POST',
          headers: {
            authorization: `bearer ${apnsJwt}`,
            'apns-topic': apnsBundleId,
            'apns-push-type': 'alert',
            'apns-priority': '10',
            'content-type': 'application/json',
          },
          body: JSON.stringify(payload),
        })

        if (res.ok) {
          sentCount++
          console.log(`[Push] Sent to ${user_id} (${tokenPrefix(token)})`)
          continue
        }

        const errBody = await safeResponseText(res)
        console.error(`[Push] APNS failed status=${res.status} token=${tokenPrefix(token)} body=${errBody}`)

        if (shouldDeleteToken(res.status, errBody)) {
          staleTokens.push(token)
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.error(`[Push] APNS failed status=network token=${tokenPrefix(token)} body=${message}`)
      }
    }

    if (staleTokens.length > 0) {
      const { error: delErr } = await supabaseAdmin
        .from('push_tokens')
        .delete()
        .in('token', staleTokens)

      if (delErr) {
        console.error('[Push] Failed to delete stale tokens:', delErr.message)
      } else {
        console.log(`[Push] Cleaned up ${staleTokens.length} stale token(s)`)
      }
    }

    return jsonResp({
      ok: true,
      sent: sentCount,
      total: tokens.length,
      iosTotal: iosTokens.length,
      notified: walkerIds.length,
      staleRemoved: staleTokens.length,
    }, 200)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('send-push-notification error:', message)
    return jsonResp({ error: 'Internal server error' }, 500)
  }
})

async function createApnsJwt(privateKeyPem: string, keyId: string, teamId: string): Promise<string> {
  const cryptoKey = await importPkcs8PrivateKey(privateKeyPem)
  const header = { alg: 'ES256', kid: keyId }
  const claims = {
    iss: teamId,
    iat: Math.floor(Date.now() / 1000),
  }

  const signingInput = `${base64UrlEncodeJson(header)}.${base64UrlEncodeJson(claims)}`
  const signature = new Uint8Array(await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    cryptoKey,
    new TextEncoder().encode(signingInput),
  ))
  const joseSignature = normalizeEs256Signature(signature)

  return `${signingInput}.${base64UrlEncodeBytes(joseSignature)}`
}

async function importPkcs8PrivateKey(privateKeyPem: string): Promise<CryptoKey> {
  const normalizedPem = privateKeyPem.replace(/\\n/g, '\n').trim()
  const cleanKey = normalizedPem
    .replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\s+/g, '')

  const keyData = base64Decode(cleanKey)

  return await crypto.subtle.importKey(
    'pkcs8',
    keyData,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  )
}

function buildNormalizedPushData(params: {
  envelope: ReturnType<typeof buildPushEnvelope>
  dedupKey: string
  dedupWindowMs: number
  data?: Record<string, string | number | boolean | null | undefined>
}): Record<string, string> {
  const extras = normalizeDataRecord(params.data)

  return {
    ...extras,
    type: params.envelope.type,
    title: params.envelope.title,
    body: params.envelope.body,
    related_job_id: params.envelope.related_job_id ?? '',
    relatedJobId: params.envelope.related_job_id ?? '',
    deep_link: params.envelope.deepLink ?? '',
    deepLink: params.envelope.deepLink ?? '',
    created_at: params.envelope.created_at,
    dedup_key: params.dedupKey,
    dedup_id: params.envelope.dedup_id ?? '',
    dedupId: params.envelope.dedup_id ?? '',
    dedup_window_ms: String(params.dedupWindowMs),
    source: 'regli',
  }
}

function normalizeDataRecord(
  data?: Record<string, string | number | boolean | null | undefined>,
): Record<string, string> {
  if (!data) return {}

  const normalized: Record<string, string> = {}
  for (const [key, value] of Object.entries(data)) {
    if (value === null || value === undefined) continue
    normalized[key] = String(value)
  }

  return normalized
}

function getApnsEnvironment(value: string | undefined): ApnsEnvironment {
  return value?.toLowerCase() === 'production' ? 'production' : 'sandbox'
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

type LanguageResolutionResult = {
  resolvedLanguage: 'en' | 'he'
  source: 'user_metadata' | 'profile' | 'fallback'
}

async function resolveTargetUserLanguage(params: {
  supabaseAdmin: ReturnType<typeof createClient>
  targetUserId: string
  payloadProfileLanguage: string | null
  appLanguage: string | null
}): Promise<LanguageResolutionResult> {
  const metadataLanguage = await getTargetUserPreferredLanguage(params.supabaseAdmin, params.targetUserId)
  if (metadataLanguage) {
    return {
      resolvedLanguage: resolvePushCopyLanguage(metadataLanguage),
      source: 'user_metadata',
    }
  }

  const profileLanguage = await getTargetUserProfileLanguage(params.supabaseAdmin, params.targetUserId)
  if (profileLanguage) {
    return {
      resolvedLanguage: resolvePushCopyLanguage(profileLanguage),
      source: 'profile',
    }
  }

  return {
    resolvedLanguage: resolvePushCopyLanguage(params.payloadProfileLanguage, params.appLanguage),
    source: 'fallback',
  }
}

async function getTargetUserPreferredLanguage(
  supabaseAdmin: ReturnType<typeof createClient>,
  userId: string,
): Promise<string | null> {
  try {
    const { data, error } = await supabaseAdmin.auth.admin.getUserById(userId)
    if (error || !data?.user) return null

    return (
      readLanguageFromMetadata(data.user.user_metadata) ??
      readLanguageFromMetadata(data.user.app_metadata) ??
      null
    )
  } catch {
    return null
  }
}

async function getTargetUserProfileLanguage(
  supabaseAdmin: ReturnType<typeof createClient>,
  userId: string,
): Promise<string | null> {
  try {
    const { data, error } = await supabaseAdmin
      .from('profiles')
      .select('*')
      .eq('id', userId)
      .maybeSingle()

    if (error || !data || typeof data !== 'object') return null
    return readLanguageFromMetadata(data)
  } catch {
    return null
  }
}

function readLanguageFromMetadata(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== 'object') return null
  const record = metadata as Record<string, unknown>
  return (
    readString(record.preferred_language) ??
    readString(record.language) ??
    readString(record.locale) ??
    readString(record.app_language) ??
    null
  )
}

function shouldDeleteToken(status: number, body: string): boolean {
  if (status === 410) return true
  if (status !== 400) return false
  return body.includes('BadDeviceToken') || body.includes('Unregistered') || body.includes('DeviceTokenNotForTopic')
}

async function safeResponseText(response: Response): Promise<string> {
  try {
    return await response.text()
  } catch {
    return '<unreadable>'
  }
}

function tokenPrefix(token: string): string {
  return `${token.slice(0, 8)}...`
}

function base64Decode(str: string): ArrayBuffer {
  const binary = atob(str)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes.buffer
}

function base64UrlEncodeJson(value: unknown): string {
  return base64UrlEncodeBytes(new TextEncoder().encode(JSON.stringify(value)))
}

function base64UrlEncodeBytes(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }

  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

function normalizeEs256Signature(signature: Uint8Array): Uint8Array {
  if (signature[0] === 0x30) {
    return derToJose(signature, 64)
  }

  if (signature.length === 64) {
    return signature
  }

  throw new Error(`Unsupported ECDSA signature length: ${signature.length}`)
}

function derToJose(signature: Uint8Array, outputLength: number): Uint8Array {
  if (signature.length < 8 || signature[0] !== 0x30) {
    throw new Error('Invalid DER signature format')
  }

  let offset = 1
  const sequence = readDerLength(signature, offset)
  offset = sequence.offset

  if (sequence.length !== signature.length - offset) {
    throw new Error('Invalid DER sequence length')
  }

  if (signature[offset++] !== 0x02) {
    throw new Error('Invalid DER signature integer for r')
  }
  const rLength = readDerLength(signature, offset)
  offset = rLength.offset
  const r = signature.slice(offset, offset + rLength.length)
  offset += rLength.length

  if (signature[offset++] !== 0x02) {
    throw new Error('Invalid DER signature integer for s')
  }
  const sLength = readDerLength(signature, offset)
  offset = sLength.offset
  const s = signature.slice(offset, offset + sLength.length)

  const componentLength = outputLength / 2
  const jose = new Uint8Array(outputLength)
  jose.set(trimAndPadDerInteger(r, componentLength), 0)
  jose.set(trimAndPadDerInteger(s, componentLength), componentLength)

  return jose
}

function readDerLength(bytes: Uint8Array, offset: number): { length: number; offset: number } {
  const first = bytes[offset]
  if ((first & 0x80) === 0) {
    return { length: first, offset: offset + 1 }
  }

  const byteCount = first & 0x7f
  if (byteCount === 0 || byteCount > 4) {
    throw new Error('Invalid DER length encoding')
  }

  let length = 0
  for (let i = 0; i < byteCount; i++) {
    length = (length << 8) | bytes[offset + 1 + i]
  }

  return { length, offset: offset + 1 + byteCount }
}

function trimAndPadDerInteger(value: Uint8Array, size: number): Uint8Array {
  let start = 0
  while (start < value.length - 1 && value[start] === 0) {
    start++
  }

  const normalized = value.slice(start)
  if (normalized.length > size) {
    throw new Error('DER integer too large')
  }

  const output = new Uint8Array(size)
  output.set(normalized, size - normalized.length)
  return output
}

function jsonResp(data: unknown, status: number): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}
