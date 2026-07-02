// ============================================================
// create-teacher
//
// Deploy this via the Supabase Dashboard (no CLI needed):
//   Project > Edge Functions > Deploy a new function > Via Editor
//   Name it exactly: create-teacher
//   Paste this whole file in, click Deploy.
//
// SUPABASE_URL, SUPABASE_ANON_KEY, and SUPABASE_SERVICE_ROLE_KEY are
// automatically available as environment variables inside every Edge
// Function — you don't need to set them yourself.
//
// What it does: verifies the caller is logged in AND has role='admin'
// in the profiles table, then (and only then) uses the service role
// key to create a new auth user + a matching profiles row with
// role='teacher'. The service role key never leaves this function —
// the browser only ever talks to this endpoint, authenticated with
// the admin's own login session.
// ============================================================
import { createClient } from 'jsr:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) throw new Error('Missing Authorization header — are you logged in?');

    // Client scoped to whoever is calling, so we can find out who they are.
    const callerClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } }
    );

    const { data: { user }, error: userError } = await callerClient.auth.getUser();
    if (userError || !user) throw new Error('Not authenticated.');

    // Privileged client — only used server-side, never sent to the browser.
    const adminClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    const { data: callerProfile } = await adminClient
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .single();

    if (!callerProfile || callerProfile.role !== 'admin') {
      throw new Error('Only admins can create teacher accounts.');
    }

    const { email, password } = await req.json();
    if (!email || !password) throw new Error('Email and password are both required.');
    if (password.length < 8) throw new Error('Password must be at least 8 characters.');

    const { data: newUser, error: createError } = await adminClient.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (createError) throw createError;

    const { error: profileError } = await adminClient.from('profiles').insert({
      id: newUser.user.id,
      email,
      role: 'teacher',
    });
    if (profileError) throw profileError;

    return new Response(JSON.stringify({ success: true }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200,
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 400,
    });
  }
});
