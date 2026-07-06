import type { PayMeApiResult, PayMeConfig, PayMeEnvironment, PayMeRequestOptions } from './types'

const DEFAULT_TIMEOUT_MS = 15_000
type PayMeErrorCode = Exclude<PayMeApiResult<unknown>, { ok: true }>['code']

export class PayMeError extends Error {
  readonly code: PayMeErrorCode
  readonly status: number | null
  readonly details: string | null

  constructor(
    message: string,
    options: {
      code: PayMeErrorCode
      status?: number | null
      details?: string | null
    },
  ) {
    super(message)
    this.name = 'PayMeError'
    this.code = options.code
    this.status = options.status ?? null
    this.details = options.details ?? null
  }
}

function normalizeEnv(value: string | undefined): PayMeEnvironment {
  return value === 'production' ? 'production' : 'sandbox'
}

function normalizeString(value: string | undefined): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  return normalized.length > 0 ? normalized : null
}

export function getPayMeConfig(): PayMeConfig {
  return {
    baseUrl: normalizeString(import.meta.env.VITE_PAYME_BASE_URL),
    partnerId: normalizeString(import.meta.env.VITE_PAYME_PARTNER_ID),
    clientKey: normalizeString(import.meta.env.VITE_PAYME_CLIENT_KEY),
    environment: normalizeEnv(import.meta.env.VITE_PAYME_ENV),
  }
}

export function isPayMeConfigured(config: PayMeConfig = getPayMeConfig()): boolean {
  return !!(config.baseUrl && config.partnerId && config.clientKey)
}

export function assertPayMeConfigured(config: PayMeConfig = getPayMeConfig()): PayMeConfig {
  if (!isPayMeConfigured(config)) {
    throw new PayMeError(
      'PayMe is not configured. Set VITE_PAYME_BASE_URL, VITE_PAYME_PARTNER_ID, and VITE_PAYME_CLIENT_KEY.',
      { code: 'not_configured' },
    )
  }
  return config
}

function joinUrl(baseUrl: string, path: string): string {
  const normalizedBase = baseUrl.replace(/\/+$/, '')
  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  return `${normalizedBase}${normalizedPath}`
}

export async function payMeRequest<T>(
  options: PayMeRequestOptions,
  config: PayMeConfig = getPayMeConfig(),
): Promise<PayMeApiResult<T>> {
  if (!isPayMeConfigured(config)) {
    return {
      ok: false,
      error:
        'PayMe is not configured. Set VITE_PAYME_BASE_URL, VITE_PAYME_PARTNER_ID, and VITE_PAYME_CLIENT_KEY.',
      status: null,
      code: 'not_configured',
      details: null,
    }
  }

  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS)

  try {
    const response = await fetch(joinUrl(config.baseUrl!, options.path), {
      method: options.method ?? 'GET',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-PayMe-Partner-Id': config.partnerId!,
        'X-PayMe-Client-Key': config.clientKey!,
        'X-PayMe-Environment': config.environment,
        ...options.headers,
      },
      body: options.body == null ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
    })

    let parsedBody: unknown = null
    try {
      parsedBody = await response.json()
    } catch {
      parsedBody = null
    }

    if (!response.ok) {
      const details =
        parsedBody && typeof parsedBody === 'object' && 'message' in parsedBody
          ? String((parsedBody as { message?: unknown }).message ?? '')
          : null

      return {
        ok: false,
        error: `PayMe request failed with status ${response.status}`,
        status: response.status,
        code: 'http_error',
        details,
      }
    }

    return {
      ok: true,
      data: parsedBody as T,
      status: response.status,
    }
  } catch (error) {
    const aborted =
      error instanceof DOMException
        ? error.name === 'AbortError'
        : error instanceof Error && error.name === 'AbortError'

    return {
      ok: false,
      error: aborted ? 'PayMe request timed out' : 'PayMe request failed',
      status: null,
      code: 'network_error',
      details: error instanceof Error ? error.message : String(error),
    }
  } finally {
    window.clearTimeout(timeout)
  }
}
