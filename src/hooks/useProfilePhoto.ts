import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../services/supabaseClient'

/**
 * Manages profile avatar: loads current URL, uploads new photo,
 * and updates the profiles table.
 */
export function useProfilePhoto(profileId: string) {
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Load current avatar_url from profiles
  useEffect(() => {
    supabase
      .from('profiles')
      .select('avatar_url')
      .eq('id', profileId)
      .maybeSingle()
      .then(({ data }) => {
        if (data?.avatar_url) setAvatarUrl(data.avatar_url)
      })
  }, [profileId])

  const uploadAvatar = useCallback(async (file: File) => {
    setError(null)
    setUploading(true)

    try {
      // Validate
      if (!file.type.startsWith('image/')) {
        setError('Please select an image file')
        return
      }
      if (file.size > 5 * 1024 * 1024) {
        setError('Image must be under 5 MB')
        return
      }

      const ext = file.name.split('.').pop() || 'jpg'
      const path = `${profileId}/avatar.${ext}`

      const { error: uploadErr } = await supabase.storage
        .from('avatars')
        .upload(path, file, { upsert: true, contentType: file.type })

      if (uploadErr) {
        setError(uploadErr.message)
        return
      }

      const { data: urlData } = supabase.storage
        .from('avatars')
        .getPublicUrl(path)

      const publicUrl = urlData.publicUrl + '?t=' + Date.now()

      // Update profile
      const { error: updateErr } = await supabase
        .from('profiles')
        .update({ avatar_url: publicUrl })
        .eq('id', profileId)

      if (updateErr) {
        setError(updateErr.message)
        return
      }

      setAvatarUrl(publicUrl)
    } catch {
      setError('Upload failed — please try again')
    } finally {
      setUploading(false)
    }
  }, [profileId])

  return { avatarUrl, uploading, error, uploadAvatar }
}
