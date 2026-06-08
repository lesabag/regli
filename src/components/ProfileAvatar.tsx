import { useEffect, useMemo, useState } from 'react'
import { getAvatarInitials, markBrokenAvatarUrl, resolveAvatarImageUrl } from '../utils/avatarImage'

interface ProfileAvatarProps {
  url: string | null
  name: string
  size?: number
  borderRadius?: number
  onClick?: () => void
}

/**
 * Shows the user's profile photo if available, otherwise a clean
 * default person icon (no letter fallback). Tappable when onClick is set.
 */
export default function ProfileAvatar({
  url,
  name,
  size = 44,
  borderRadius = 14,
  onClick,
}: ProfileAvatarProps) {
  const containerStyle: React.CSSProperties = {
    width: size,
    height: size,
    borderRadius,
    overflow: 'hidden',
    flexShrink: 0,
    cursor: onClick ? 'pointer' : 'default',
    WebkitTapHighlightColor: 'transparent',
    position: 'relative',
    background: url ? '#E2E8F0' : '#0F172A',
    display: 'grid',
    placeItems: 'center',
  }

  const resolvedUrl = useMemo(
    () => resolveAvatarImageUrl(url, { size: Math.max(96, size * 2) }),
    [size, url],
  )
  const [imageErrored, setImageErrored] = useState(false)

  useEffect(() => {
    setImageErrored(false)
  }, [resolvedUrl])

  if (resolvedUrl && !imageErrored) {
    return (
      <div
        style={containerStyle}
        onClick={onClick}
        role={onClick ? 'button' : undefined}
        aria-label={name}
      >
        <img
          src={resolvedUrl}
          alt={name}
          onError={() => {
            markBrokenAvatarUrl(resolvedUrl)
            setImageErrored(true)
          }}
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            display: 'block',
          }}
        />
      </div>
    )
  }

  const initials = getAvatarInitials(name)
  return (
    <div
      style={containerStyle}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      aria-label={name}
    >
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'grid',
          placeItems: 'center',
          background: 'linear-gradient(180deg, #E2E8F0 0%, #CBD5E1 100%)',
          color: '#334155',
          fontSize: Math.max(12, Math.round(size * 0.32)),
          fontWeight: 900,
          letterSpacing: '0.04em',
        }}
      >
        {initials}
      </div>
    </div>
  )
}
