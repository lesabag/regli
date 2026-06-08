type AvatarWindow = Window & {
  __regliBrokenAvatarUrls?: Record<string, true>
}

const THUMBNAIL_EXTENSIONS = new Set(['jpg', 'jpeg', 'png'])

function getAvatarWindow(): AvatarWindow | null {
  if (typeof window === 'undefined') return null
  return window as AvatarWindow
}

function getPathExtension(pathname: string): string {
  const lastSegment = pathname.split('/').pop() ?? ''
  const dotIndex = lastSegment.lastIndexOf('.')
  return dotIndex >= 0 ? lastSegment.slice(dotIndex + 1).toLowerCase() : ''
}

export function getAvatarInitials(name: string | null | undefined): string {
  const base = name?.trim() || 'Provider'
  const parts = base.split(/\s+/).filter(Boolean).slice(0, 2)
  const initials = parts.map((part) => part[0]?.toUpperCase() ?? '').join('')
  return initials || 'P'
}

export function isBrokenAvatarUrl(url: string | null | undefined): boolean {
  if (!url) return false
  const avatarWindow = getAvatarWindow()
  return Boolean(avatarWindow?.__regliBrokenAvatarUrls?.[url])
}

export function markBrokenAvatarUrl(url: string | null | undefined): void {
  if (!url) return
  const avatarWindow = getAvatarWindow()
  if (!avatarWindow) return
  avatarWindow.__regliBrokenAvatarUrls = avatarWindow.__regliBrokenAvatarUrls ?? {}
  avatarWindow.__regliBrokenAvatarUrls[url] = true
}

export function resolveAvatarImageUrl(
  url: string | null | undefined,
  options?: { size?: number },
): string | null {
  if (!url || isBrokenAvatarUrl(url)) return null

  const size = Math.max(48, Math.round(options?.size ?? 96))

  try {
    const parsed = new URL(url)
    const extension = getPathExtension(parsed.pathname)
    if (parsed.pathname.includes('/storage/v1/object/public/') && THUMBNAIL_EXTENSIONS.has(extension)) {
      parsed.pathname = parsed.pathname.replace('/storage/v1/object/public/', '/storage/v1/render/image/public/')
      parsed.searchParams.set('width', String(size))
      parsed.searchParams.set('height', String(size))
      parsed.searchParams.set('resize', 'cover')
      parsed.searchParams.set('quality', '72')
      parsed.searchParams.set('format', 'origin')
      const renderedUrl = parsed.toString()
      return isBrokenAvatarUrl(renderedUrl) ? null : renderedUrl
    }

    return isBrokenAvatarUrl(parsed.toString()) ? null : parsed.toString()
  } catch {
    return null
  }
}
