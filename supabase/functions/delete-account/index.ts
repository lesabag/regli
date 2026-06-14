import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.100.0'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY')
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')

    if (!supabaseUrl || !supabaseAnonKey || !serviceRoleKey) {
      return new Response(
        JSON.stringify({ error: 'Server misconfigured' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: 'Missing authorization' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    const supabaseUser = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    })
    const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey)

    const { data: { user }, error: authError } = await supabaseUser.auth.getUser()
    if (authError || !user) {
      return new Response(
        JSON.stringify({ error: 'Invalid token' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    console.log('[delete-account] start', {
      user_id: user.id,
      action: 'start',
    })

    const deletedAt = new Date().toISOString()
    const deletedEmail = `deleted+${user.id}@regli.invalid`
    const deletedName = 'Deleted account'

    async function deleteWhere(table: string, column: string, value: string) {
      const { error } = await supabaseAdmin.from(table).delete().eq(column, value)
      if (error) {
        throw new Error(`${table}.${column}: ${error.message}`)
      }
      console.log('[delete-account] cleanup', {
        user_id: user.id,
        action: 'delete_rows',
        table,
        column,
      })
    }

    await deleteWhere('push_tokens', 'user_id', user.id)
    await deleteWhere('legal_acceptances', 'user_id', user.id)
    await deleteWhere('notifications', 'user_id', user.id)
    await deleteWhere('client_pets', 'client_id', user.id)
    await deleteWhere('recurring_bookings', 'client_id', user.id)
    await deleteWhere('favorite_walkers', 'client_id', user.id)
    await deleteWhere('favorite_walkers', 'walker_id', user.id)
    await deleteWhere('favorite_customers', 'client_id', user.id)
    await deleteWhere('favorite_customers', 'walker_id', user.id)
    await deleteWhere('provider_availability', 'provider_id', user.id)
    await deleteWhere('provider_service_preferences', 'provider_id', user.id)
    await deleteWhere('provider_capabilities', 'provider_id', user.id)

    const { error: profileError } = await supabaseAdmin
      .from('profiles')
      .update({
        email: deletedEmail,
        full_name: deletedName,
        avatar_url: null,
        short_bio: null,
        whatsapp_number: null,
        primary_service: null,
        location_address: null,
        service_type: null,
        service_types: null,
        service_attributes: {},
        is_online: false,
        last_lat: null,
        last_lng: null,
      })
      .eq('id', user.id)

    if (profileError) {
      throw new Error(`profiles.update: ${profileError.message}`)
    }

    console.log('[delete-account] profile_anonymized', {
      user_id: user.id,
      action: 'profile_anonymized',
      deleted_at: deletedAt,
    })

    const { error: deleteUserError } = await supabaseAdmin.auth.admin.deleteUser(user.id)
    if (deleteUserError) {
      throw new Error(`auth.deleteUser: ${deleteUserError.message}`)
    }

    console.log('[delete-account] success', {
      user_id: user.id,
      action: 'success',
      deleted_at: deletedAt,
    })

    return new Response(
      JSON.stringify({ success: true }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    )
  } catch (error) {
    console.error('[delete-account] failure', {
      action: 'failure',
      error: error instanceof Error ? error.message : String(error),
    })
    return new Response(
      JSON.stringify({ error: 'Could not delete account right now' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    )
  }
})
