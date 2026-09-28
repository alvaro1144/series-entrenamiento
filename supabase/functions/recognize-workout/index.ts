const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...corsHeaders, "Content-Type": "application/json" },
});

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const authorization = request.headers.get("Authorization");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const openaiKey = Deno.env.get("OPENAI_API_KEY");
  if (!authorization || !supabaseUrl || !anonKey) return json({ error: "Unauthorized" }, 401);
  if (!openaiKey) return json({ error: "OpenAI is not configured" }, 503);

  try {
    const userResponse = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: { Authorization: authorization, apikey: anonKey },
    });
    if (!userResponse.ok) return json({ error: "Invalid session" }, 401);
    const payload = await request.json();
    const image = payload?.image;
    if (typeof image !== "string" || image.length > 12_000_000 || !/^data:image\/(jpeg|png|webp);base64,/.test(image)) {
      return json({ error: "Invalid or oversized image" }, 400);
    }

    const quotaResponse = await fetch(`${supabaseUrl}/rest/v1/rpc/consume_recognition_quota`, {
      method: "POST",
      headers: {
        Authorization: authorization,
        apikey: anonKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ p_daily_limit: 5 }),
    });
    if (!quotaResponse.ok) return json({ error: "Could not check daily recognition limit" }, 503);
    if (await quotaResponse.json() !== true) return json({ error: "Daily image recognition limit reached (5 per day)" }, 429);

    const openaiResponse = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${openaiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0,
        max_tokens: 1800,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: "Extrae de la imagen una rutina de entrenamiento. Devuelve exclusivamente un objeto JSON con la clave exercises, que contenga una lista de objetos con name, sets, reps, obs, weight y notes. Usa strings en todos los campos. sets y reps deben ser cantidades o rangos que se lean en la imagen; obs recoge tempos, RPE, instrucciones y superseries pertinentes. weight y notes deben quedar vacíos salvo que la imagen indique explícitamente esos datos. No inventes información. Omite encabezados, descansos y texto que no sea un ejercicio. Si no hay ejercicios, devuelve {\"exercises\":[]}. Responde en el idioma del texto de la imagen y conserva los nombres de ejercicio tal como aparecen.",
          },
          {
            role: "user",
            content: [
              { type: "text", text: "Lee esta captura de una rutina y extrae los ejercicios." },
              { type: "image_url", image_url: { url: image, detail: "high" } },
            ],
          },
        ],
      }),
    });
    const openaiResult = await openaiResponse.json();
    if (!openaiResponse.ok) {
      console.error("OpenAI error", openaiResult);
      return json({ error: "OpenAI image recognition failed" }, 502);
    }

    let parsed;
    try {
      parsed = JSON.parse(openaiResult.choices?.[0]?.message?.content || "{}");
    } catch {
      return json({ error: "Could not parse recognition result" }, 502);
    }
    const exercises = Array.isArray(parsed.exercises) ? parsed.exercises.slice(0, 100).map((item: Record<string, unknown>) => ({
      name: String(item.name ?? "").slice(0, 160),
      sets: String(item.sets ?? "").slice(0, 40),
      reps: String(item.reps ?? "").slice(0, 60),
      obs: String(item.obs ?? "").slice(0, 500),
      weight: String(item.weight ?? "").slice(0, 40),
      notes: String(item.notes ?? "").slice(0, 500),
    })).filter((item: { name: string }) => item.name.trim().length > 0) : [];
    return json({ exercises });
  } catch (error) {
    console.error("Recognition function error", error);
    return json({ error: "Image recognition could not be completed" }, 500);
  }
});

