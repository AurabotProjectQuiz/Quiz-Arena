// ============================================================
// Supabase connection
// Fill these in from your Supabase project: Settings > API
// The anon key is safe to expose in client code — it only has the
// permissions granted by your Row Level Security policies.
// ============================================================
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const SUPABASE_URL = 'https://veejwshsxzwssiuzlpru.supabase.co';
   const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZlZWp3c2hzeHp3c3NpdXpscHJ1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI5NzI3NzAsImV4cCI6MjA5ODU0ODc3MH0.LsIT2Yiuy1-CMRJ-GQooqruTtHi_9_c3MqQuYgsMg8Y';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  realtime: {
    params: {
      eventsPerSecond: 10,
    },
  },
});
