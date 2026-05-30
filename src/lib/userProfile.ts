import { supabase } from './supabase'

export type UserProfile = {
  id: string
  location_label: string | null
  latitude: number | null
  longitude: number | null
  timezone: string | null
  updated_at: string
}

export async function loadUserProfile(userId: string): Promise<UserProfile | null> {
  if (!supabase) return null

  const { data, error } = await supabase
    .from('user_profiles')
    .select('*')
    .eq('id', userId)
    .maybeSingle()

  if (error) {
    console.error('Failed to load user profile:', error.message)
    return null
  }

  return data as UserProfile | null
}

export async function saveUserLocation(
  userId: string,
  location: {
    location_label: string
    latitude: number
    longitude: number
    timezone: string
  },
): Promise<{ error: string | null }> {
  if (!supabase) return { error: 'Supabase not configured' }

  const { error } = await supabase
    .from('user_profiles')
    .upsert(
      { id: userId, ...location, updated_at: new Date().toISOString() },
      { onConflict: 'id' },
    )

  if (error) {
    return { error: error.message }
  }

  return { error: null }
}
