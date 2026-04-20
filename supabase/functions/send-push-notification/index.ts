import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.100.0'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

/**
 * send-push-notification
 *
 * Sends an APNs push notification to all walkers (or a specific user).
 * Also creates in-app notification records for broadcast notifications
 * (new job requests sent to all online walkers).
 *
 * Request body:
 *   { title, body, targetUserId?, data?, createInAppNotification? }
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
    const apnsKeyId = Deno.env.get('APNS_KEY_ID')
    const apnsTeamId = Deno.env.get('APNS_TEAM_ID')
    const apnsKeyP8 = Deno.env.get('APNS_KEY_P8')
    const appBundleId = Deno.env.get('APP_BUNDLE_ID') || 'com.regli.app'
    const apnsEnv = Deno.env.get('APNS_ENVIRONMENT') || 'development'

    if (!supabaseUrl || !serviceRoleKey) {
      return jsonResp({ error: 'Server misconfigured (supabase)' }, 500)
    }
    if (!apnsKeyId || !apnsTeamId || !apnsKeyP8) {
      return jsonResp({ error: 'Server misconfigured (apns)' }, 500)
    }

    // Auth: verify caller is authenticated
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      return jsonResp({ error: 'Missing authorization' }, 401)
    }

    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY') || ''
    const supabaseUser = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    })
    const { data: { user }, error: authError } = await supabaseUser.auth.getUser()
    if (authError || !user) {
      return jsonResp({ error: 'Invalid token' }, 401)
    }

    // Parse body
    let body: {
      title?: string
      body?: string
      targetUserId?: string
      data?: Record<string, string>
      createInAppNotification?: boolean
      inAppType?: string
      inAppTitle?: string
      inAppMessage?: string
    }
    try {
      body = await req.json()
    } catch {
      return jsonResp({ error: 'Invalid request body' }, 400)
    }

    const { title, body: notifBody, targetUserId, data: notifData } = body
    if (!title || !notifBody) {
      return jsonResp({ error: 'Missing title or body' }, 400)
    }

    // Fetch push tokens
    const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey)

    let walkerIds: string[] = []

    let query = supabaseAdmin
      .from('push_tokens')
      .select('token, user_id')

    if (targetUserId) {
      // Send to specific user
      query = query.eq('user_id', targetUserId)
    } else {
      // Send to all online walkers
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

      // Create in-app notifications for all online walkers (new request broadcast)
      const jobId = notifData?.jobId || null
      const inAppType = body.inAppType || 'new_request'
      const inAppTitle = body.inAppTitle || title
      const inAppMessage = body.inAppMessage || notifBody

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
      return jsonResp({ sent: 0, notified: walkerIds.length, message: 'No push tokens found (in-app notifications still created)' }, 200)
    }

    // Generate APNs JWT
    const jwt = await createApnsJwt(apnsKeyP8, apnsKeyId, apnsTeamId)

    const apnsHost = apnsEnv === 'production'
      ? 'https://api.push.apple.com'
      : 'https://api.sandbox.push.apple.com'

    // Send push to each token
    const staleTokens: string[] = []
    let sentCount = 0

    for (const { token, user_id } of tokens) {
      try {
        const res = await fetch(`${apnsHost}/3/device/${token}`, {
          method: 'POST',
          headers: {
            'authorization': `bearer ${jwt}`,
            'apns-topic': appBundleId,
            'apns-push-type': 'alert',
            'apns-priority': '10',
            'apns-expiration': '0',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            aps: {
              alert: { title, body: notifBody },
              sound: 'default',
              badge: 1,
            },
            ...(notifData || {}),
          }),
        })

        if (res.ok) {
          sentCount++
          console.log(`[Push] Sent to ${user_id} (${token.slice(0, 8)}...)`)
        } else {
          const errBody = await res.text()
          console.error(`[Push] APNs error ${res.status} for ${token.slice(0, 8)}...: ${errBody}`)

          if (res.status === 410 || res.status === 400) {
            staleTokens.push(token)
          }
        }
      } catch (err) {
        console.error(`[Push] Failed to send to ${token.slice(0, 8)}...:`, err)
      }
    }

    // Clean up stale tokens
    if (staleTokens.length > 0) {
      const { error: delErr } = await supabaseAdmin
        .from('push_tokens')
        .delete()
        .in('token', staleTokens)

      if (delErr) {
        console.error('[Push] Failed to delete stale tokens:', delErr)
      } else {
        console.log(`[Push] Cleaned up ${staleTokens.length} stale token(s)`)
      }
    }

    return jsonResp({
      sent: sentCount,
      total: tokens.length,
      notified: walkerIds.length,
      staleRemoved: staleTokens.length,
    }, 200)
  } catch (err) {
    console.error('send-push-notification error:', err)
    return jsonResp({ error: 'Internal server error' }, 500)
  }
})

// ─── APNs JWT generation ──────────────────────────────────────

async function createApnsJwt(p8Key: string, keyId: string, teamId: string): Promise<string> {
  const cleanKey = p8Key
    .replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\s/g, '')

  const keyData = base64Decode(cleanKey)

  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8',
    keyData,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  )

  const header = { alg: 'ES256', kid: keyId }
  const now = Math.floor(Date.now() / 1000)
  const claims = { iss: teamId, iat: now }

  const headerB64 = base64UrlEncode(JSON.stringify(header))
  const claimsB64 = base64UrlEncode(JSON.stringify(claims))
  const signingInput = `${headerB64}.${claimsB64}`

  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    cryptoKey,
    new TextEncoder().encode(signingInput)
  )

  const sigBytes = new Uint8Array(signature)
  const signatureB64 = base64UrlEncodeBytes(sigBytes)

  return `${signingInput}.${signatureB64}`
}

function base64Decode(str: string): ArrayBuffer {
  const binary = atob(str)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes.buffer
}

function base64UrlEncode(str: string): string {
  return btoa(str)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
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

function jsonResp(data: unknown, status: number): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}
