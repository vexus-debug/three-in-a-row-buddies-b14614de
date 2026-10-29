import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const GATEWAY = "https://ai.gateway.lovable.dev/v1";
const CHAT_MODEL = "openai/gpt-6-astra";
const IMAGE_MODEL = "openai/gpt-image-2.5-sunburst";
const BUCKET = "article-covers";
export const CATEGORIES = ["practice", "marketing", "dental", "eye-care", "laboratory", "technology"] as const;

/** Asks the AI for a fresh, SEO-worthy brief in a category, avoiding existing titles. */
export async function planAutoBrief(category: string, existingTitles: string[]) {
  const text = await respond({
    instructions: `You are the Clinexus content strategist.
${CLINEXUS_BRIEF}
Propose ONE new blog article brief for the "${category}" category in 3-5 sentences: a working title, the one reader it speaks to, the search keyword they'd type into Google, the angle and key points. It must help that reader genuinely and position Clinexus as the expert. Do not repeat these existing titles:
${existingTitles.map((t) => `- ${t}`).join("\n") || "(none)"}`,
    input: [{ role: "user", content: `Today's ${category} article brief.` }],
    reasoning: { effort: "low" },
  });
  return text.trim();
}

const CLINEXUS_BRIEF = `ABOUT CLINEXUS (use this knowledge accurately; never invent features):
Clinexus is a cloud clinic management platform for dental clinics, eye clinics / optometry, diagnostic laboratories and dental labs, serving clinics in Nigeria and beyond.
Key capabilities:
- Patients & records: registration, history, documents, images, consent forms with e-signature, clinical (SOAP) notes.
- Appointments: scheduling, walk-ins, waiting list/queue, dentist schedules, chairs, reminders.
- Dental: interactive dental charts, treatment plans and estimates, lab cases sent to dental labs, materials auto-consumed from stock.
- Eye care: eye exams, optical prescriptions, glasses/optical orders, frame and lens stock, contact lens fittings, surgery bookings, referrals.
- Laboratory/diagnostics: test menus, sample tracking with serial numbers, result approval, secure public result links patients check themselves.
- Finance: invoices, payments, payment plans, registration fees, expenses, revenue & commission allocation, profitability per treatment.
- Inventory & procurement: stock levels, suppliers, purchase orders, stock transfers between branches.
- Multi-branch organisations, role-based staff access (owner, dentist, receptionist, accountant, lab tech, etc.), audit log.
- Team messaging, notifications, automation workflows, patient reviews, clinic website & online shop, installable mobile app with push notifications, built-in AI copilot.
Editorial voice: practical, warm, plain English, written for clinic owners, practice managers and front-desk teams. No hype, no medical advice beyond general good practice. Mention Clinexus naturally where it genuinely solves the problem — usually once or twice, near the end.`;

async function requireSuperAdmin(token: string) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data: u, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !u.user) throw new Error("Please sign in again");
  const { data: isAdmin } = await supabaseAdmin.rpc("is_super_admin", { _user_id: u.user.id });
  if (!isAdmin) throw new Error("Only super admins can use the content studio");
  return { supabaseAdmin, userId: u.user.id };
}

function gatewayError(status: number, text: string) {
  let msg = text;
  try {
    const j = JSON.parse(text);
    msg = j?.error?.message || j?.message || text;
  } catch { /* keep text */ }
  if (status === 402) return new Error(msg || "AI credits are used up. Add credits to keep generating.");
  if (status === 429) return new Error("The AI is busy right now. Please wait a moment and try again.");
  return new Error(msg || `AI request failed (${status})`);
}

/** Streams a Responses call and returns the final text. */
async function respond(body: Record<string, unknown>): Promise<string> {
  const key = process.env.LOVABLE_API_KEY;
  if (!key) throw new Error("AI is not configured");
  const res = await fetch(`${GATEWAY}/responses`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
      "X-Lovable-AIG-SDK": "fetch",
    },
    body: JSON.stringify({ model: CHAT_MODEL, stream: true, store: false, ...body }),
  });
  if (!res.ok || !res.body) throw gatewayError(res.status, await res.text());
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let out = "";
  let refusal = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of frame.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        try {
          const ev = JSON.parse(data);
          if (ev.type === "response.output_text.delta") out += ev.delta ?? "";
          else if (ev.type === "response.refusal.delta") refusal += ev.delta ?? "";
          else if (ev.type === "error" || ev.type === "response.failed")
            throw new Error(ev.error?.message || ev.response?.error?.message || "AI request failed");
        } catch (e) {
          if (e instanceof SyntaxError) continue;
          throw e;
        }
      }
    }
  }
  if (!out && refusal) throw new Error("The AI declined this request.");
  return out;
}

// ─────────────── Brainstorm chat ───────────────
const chatSchema = z.object({
  token: z.string().min(10),
  messages: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(20000) }))
    .min(1)
    .max(60),
});

export const brainstormBlog = createServerFn({ method: "POST" })
  .inputValidator((d) => chatSchema.parse(d))
  .handler(async ({ data }) => {
    await requireSuperAdmin(data.token);
    const { data: existing } = await (await import("@/integrations/supabase/client.server")).supabaseAdmin
      .from("blog_articles" as any)
      .select("title")
      .order("created_at", { ascending: false })
      .limit(40);
    const titles = ((existing as any[]) ?? []).map((r) => `- ${r.title}`).join("\n");
    const instructions = `You are the Clinexus content strategist, helping a super admin plan blog articles for the Clinexus website.
${CLINEXUS_BRIEF}

Help brainstorm ideas, angles, audiences, outlines and SEO keywords. Be concise and conversational. When proposing ideas, number them and give each a working title, target audience, category (one of: ${CATEGORIES.join(", ")}) and a one-line angle.
When the admin agrees on an idea, confirm the final brief clearly and tell them to press "Generate draft". Do not write full articles in chat.
Articles already written (avoid duplicates):
${titles || "(none yet)"}`;
    const text = await respond({
      instructions,
      input: data.messages.map((m) => ({ role: m.role, content: m.content })),
      reasoning: { effort: "low" },
    });
    return { reply: text.trim() };
  });

// ─────────────── Agreed brief extraction ───────────────
const briefSchema = z.object({ token: z.string().min(10), messages: chatSchema.shape.messages });

export const extractBrief = createServerFn({ method: "POST" })
  .inputValidator((d) => briefSchema.parse(d))
  .handler(async ({ data }) => {
    await requireSuperAdmin(data.token);
    const transcript = data.messages.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join("\n\n");
    const text = await respond({
      instructions:
        "From this brainstorming conversation, write the single most recently agreed blog article brief in 2-5 sentences: topic, audience, angle, key points, keywords. If nothing is agreed yet, summarise the most promising idea discussed.",
      input: [{ role: "user", content: transcript }],
      reasoning: { effort: "low" },
    });
    return { brief: text.trim() };
  });

// ─────────────── Article + cover generation ───────────────
const genSchema = z.object({
  token: z.string().min(10),
  brief: z.string().trim().min(10).max(4000),
  category: z.enum(CATEGORIES).optional().nullable(),
});

const articleJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["title", "excerpt", "category", "imagePrompt", "body"],
  properties: {
    title: { type: "string" },
    excerpt: { type: "string" },
    category: { type: "string", enum: [...CATEGORIES] },
    imagePrompt: { type: "string" },
    body: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["type", "text", "title", "items"],
        properties: {
          type: { type: "string", enum: ["p", "h2", "h3", "list", "tip", "quote"] },
          text: { type: ["string", "null"] },
          title: { type: ["string", "null"] },
          items: { type: ["array", "null"], items: { type: "string" } },
        },
      },
    },
  },
};

const slugify = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 80);

function normaliseBody(raw: any[]) {
  return raw
    .map((b) => {
      switch (b.type) {
        case "list":
          return b.items?.length ? { type: "list", items: b.items } : null;
        case "tip":
          return b.text ? { type: "tip", text: b.text, ...(b.title ? { title: b.title } : {}) } : null;
        case "quote":
          return b.text ? { type: "quote", text: b.text } : null;
        default:
          return b.text ? { type: b.type, text: b.text } : null;
      }
    })
    .filter(Boolean);
}

function readMinutes(body: any[]) {
  const words = body
    .map((b) => (b.items ? b.items.join(" ") : b.text ?? ""))
    .join(" ")
    .split(/\s+/).length;
  return Math.max(2, Math.round(words / 220));
}

async function generateCover(prompt: string): Promise<Uint8Array | null> {
  const key = process.env.LOVABLE_API_KEY;
  if (!key) return null;
  const res = await fetch(`${GATEWAY}/images/generations`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}`, "X-Lovable-AIG-SDK": "fetch" },
    body: JSON.stringify({
      model: IMAGE_MODEL,
      prompt: `Editorial blog cover photograph, realistic, natural light, modern African clinic setting where appropriate, no text, no logos, no watermarks. ${prompt}`,
      size: "1536x1024",
      n: 1,
    }),
  });
  if (!res.ok) {
    console.error("cover generation failed", res.status, await res.text());
    return null;
  }
  const j: any = await res.json();
  const b64 = j?.data?.[0]?.b64_json;
  if (!b64) return null;
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function uploadCover(supabaseAdmin: any, slug: string, bytes: Uint8Array) {
  const { data: buckets } = await supabaseAdmin.storage.listBuckets();
  if (!buckets?.some((b: any) => b.name === BUCKET)) {
    await supabaseAdmin.storage.createBucket(BUCKET, { public: true });
  }
  const path = `${slug}-${Date.now()}.png`;
  const { error } = await supabaseAdmin.storage.from(BUCKET).upload(path, bytes, { contentType: "image/png", upsert: true });
  if (error) {
    console.error("cover upload failed", error);
    return null;
  }
  return supabaseAdmin.storage.from(BUCKET).getPublicUrl(path).data.publicUrl as string;
}

export const WRITER_INSTRUCTIONS = `You write long-form blog articles for the Clinexus website.
${CLINEXUS_BRIEF}

VOICE: Write as if talking directly to ONE person — a single clinic owner or manager reading over a cup of tea. Use "you" and "your clinic", short sentences, warm and human, a little empathy for their daily pressures ("If you've ever had a patient walk out of a full waiting room..."). Friendly, never salesy, never robotic.
GOAL: Subtly establish Clinexus as the trusted authority on running modern clinics and labs: share genuinely expert, practical insight, real numbers and frameworks, so the reader trusts Clinexus. Mention Clinexus naturally 2-3 times where it truly solves the problem — never hard-sell.
SEO: Pick one clear primary keyword phrase a clinic owner would search (e.g. "dental clinic management software Nigeria") and use it in the title, the first paragraph, at least one h2 and the closing section. Use related secondary keywords naturally. Title under 65 characters. h2s should read like questions or benefits people search for. Include a short FAQ section near the end (h2 "Frequently asked questions" followed by h3 questions with p answers).

Write a complete, original, 1300-1800 word article from the brief. Structure: an engaging opening, 5-7 "h2" sections with paragraphs, at least one "list", one or two "tip" blocks (title like "In practice"), the FAQ, and a closing section. Use only block types p, h2, h3, list, tip, quote; set unused fields to null. Excerpt: 1-2 sentences, under 160 characters, containing the primary keyword (it becomes the meta description). imagePrompt: a vivid cover photo description. sectionImagePrompts: exactly 2 vivid photo descriptions illustrating different later sections (people and setting, no text).`;

export async function writeArticle(
  supabaseAdmin: any,
  opts: { brief: string; category?: string | null; status: "draft" | "published"; userId?: string | null; auto?: boolean },
) {
  const schema = {
    ...articleJsonSchema,
    required: [...articleJsonSchema.required, "sectionImagePrompts"],
    properties: { ...articleJsonSchema.properties, sectionImagePrompts: { type: "array", items: { type: "string" } } },
  };
  const text = await respond({
    instructions: `${WRITER_INSTRUCTIONS}${opts.category ? ` Category must be "${opts.category}".` : ""}`,
    input: [{ role: "user", content: opts.brief }],
    reasoning: { effort: "medium" },
    text: { format: { type: "json_schema", name: "article", strict: true, schema } },
  });
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("The AI returned an incomplete article. Please try again.");
  }
  const body: any[] = normaliseBody(parsed.body ?? []);
  let slug = slugify(parsed.title);
  const { data: clash } = await supabaseAdmin.from("blog_articles").select("id").eq("slug", slug).maybeSingle();
  if (clash) slug = `${slug}-${Date.now().toString(36)}`;

  const prompts: string[] = [parsed.imagePrompt, ...((parsed.sectionImagePrompts ?? []) as string[]).slice(0, 2)];
  const urls: (string | null)[] = [];
  for (const [i, p] of prompts.entries()) {
    const bytes = await generateCover(p);
    urls.push(bytes ? await uploadCover(supabaseAdmin, `${slug}-${i}`, bytes) : null);
  }
  const [coverUrl, ...inline] = urls;
  // Place inline photos just before the 3rd and 5th h2 sections.
  const h2Idx = body.map((b, i) => (b.type === "h2" ? i : -1)).filter((i) => i >= 0);
  const spots = [h2Idx[2], h2Idx[4]];
  inline
    .map((src, i) => ({ src, at: spots[i], alt: prompts[i + 1] }))
    .filter((x) => x.src && x.at !== undefined)
    .sort((a, b) => b.at! - a.at!)
    .forEach((x) => body.splice(x.at!, 0, { type: "image", src: x.src, alt: x.alt.slice(0, 140) }));

  const { data: row, error } = await supabaseAdmin
    .from("blog_articles")
    .insert({
      slug,
      title: parsed.title,
      excerpt: parsed.excerpt,
      category: opts.category || parsed.category,
      body,
      cover_url: coverUrl,
      read_minutes: readMinutes(body),
      status: opts.status,
      published_at: opts.status === "published" ? new Date().toISOString() : null,
      prompt: opts.brief,
      created_by: opts.userId ?? null,
      auto_generated: !!opts.auto,
    })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  return { id: (row as any).id as string, coverFailed: !coverUrl };
}

export const generateArticleDraft = createServerFn({ method: "POST" })
  .inputValidator((d) => genSchema.parse(d))
  .handler(async ({ data }) => {
    const { supabaseAdmin, userId } = await requireSuperAdmin(data.token);
    return writeArticle(supabaseAdmin, { brief: data.brief, category: data.category, status: "draft", userId });
  });

// ─────────────── Regenerate cover ───────────────
export const regenerateCover = createServerFn({ method: "POST" })
  .inputValidator((d) => z.object({ token: z.string().min(10), id: z.string().uuid(), prompt: z.string().trim().min(5).max(1000) }).parse(d))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await requireSuperAdmin(data.token);
    const { data: a } = await supabaseAdmin.from("blog_articles" as any).select("slug").eq("id", data.id).single();
    if (!a) throw new Error("Article not found");
    const bytes = await generateCover(data.prompt);
    if (!bytes) throw new Error("Couldn't create the image. Please try again.");
    const url = await uploadCover(supabaseAdmin, (a as any).slug, bytes);
    if (!url) throw new Error("Couldn't save the image.");
    await supabaseAdmin.from("blog_articles" as any).update({ cover_url: url }).eq("id", data.id);
    return { coverUrl: url };
  });
