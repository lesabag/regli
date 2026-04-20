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

  if (url) {
    return (
      <div
        style={containerStyle}
        onClick={onClick}
        role={onClick ? 'button' : undefined}
        aria-label={name}
      >
        <img
          src={url}
          alt={name}
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

  // Default person icon (white on dark)
  const iconSize = Math.round(size * 0.5)
  return (
    <div
      style={containerStyle}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      aria-label={name}
    >
      <svg
        width={iconSize}
        height={iconSize}
        viewBox="0 0 24 24"
        fill="none"
      >
        <circle cx="12" cy="8" r="4" fill="#FFFFFF" />
        <path
          d="M12 14c-5 0-8 2.5-8 5 0 .83.67 1.5 1.5 1.5h13c.83 0 1.5-.67 1.5-1.5 0-2.5-3-5-8-5z"
          fill="#FFFFFF"
        />
      </svg>
    </div>
  )
}
