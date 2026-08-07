/**
 * product-roadmap-launch-notify
 *
 * Release notifier for the product roadmap. It claims every item sitting in
 * `queued`, flips it to `launched`, and sends one digest email per active
 * internal user via Resend.
 *
 * Two callers, two ways to authenticate:
 *
 *   Deploy webhook, machine to machine — the shared secret header:
 *     POST /functions/v1/product-roadmap-launch-notify
 *     x-launch-secret: <LAUNCH_WEBHOOK_SECRET>
 *     { "dry_run": false }
 *
 *   The dashboard button, a signed-in human — their own Supabase session:
 *     POST /functions/v1/product-roadmap-launch-notify
 *     Authorization: Bearer <the user's access token>
 *     { "dry_run": false, "test_email": "jay@superior-maintenance.com" }
 *
 *   The caller must be an active @superior-maintenance.com user. This path
 *   exists so the UI never has to ship LAUNCH_WEBHOOK_SECRET to the browser,
 *   and it records the real person on the batch rather than "weweb-deploy".
 *
 * Three modes, in increasing order of consequence:
 *
 *   {}                                  dry run (the DEFAULT). Zero side effects:
 *                                       returns the item list, the audience size
 *                                       and the rendered HTML. Nothing is sent.
 *
 *   { dry_run: false,                   one real email to that address only. The
 *     test_email: "you@example.com" }   queue is NOT consumed and no item is
 *                                       flipped, so it is safe to repeat.
 *
 *   { dry_run: false }                  the real release: flips every queued item
 *                                       to launched and emails the whole audience.
 *
 * dry_run has to be explicitly false to send anything, so a misconfigured webhook
 * cannot email the company by accident.
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { Resend } from 'https://esm.sh/resend@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-launch-secret',
}
const JSON_HEADERS = { 'Content-Type': 'application/json', ...CORS }

const FROM = 'Superior Contracting & Maintenance <product@updates.superior-maintenance.com>'
const REPLY_TO = 'product@superior-maintenance.com'
// Brand red, sampled from the solid fill of the logo file itself rather than
// eyeballed. The logo PNG is red on TRANSPARENT — it only ever looked navy
// because the old masthead sat it on a navy cell.
const RED = '#d42029'
const INK = '#1f2937'
const MUTED = '#6b7280'
const LOGO = 'https://iepfgtjizwzbdgxyzaab.supabase.co/storage/v1/object/public/avatars/headers/1_Superior_C_M_logo.png'
// Web-safe monospace stack. Carries the technical feel — no webfont to load, and
// every client falls back to something sensible.
const MONO = "'SFMono-Regular',Consolas,'Liberation Mono',Menlo,monospace"
// Says what the email is about beyond the item list. Recipients outside the
// product team will not necessarily connect "product update" to Supro.
const SUPRO_BLURB =
  'Supro is the internal system behind your jobs, dispatch, vendor and customer workflows. ' +
  'These changes are already live — sign in again or refresh to pick them up.'
// Resend's batch endpoint caps at 100 messages per call.
const BATCH_SIZE = 100

type LaunchItem = {
  notificationId: string
  itemId: string
  title: string
  // launch_notes when set, otherwise description — resolved once at fetch time
  blurb: string | null
  category: string | null
  projectId: string
  projectName: string
}

type Recipient = {
  user_id: string | null
  auth_user_id: string | null
  name: string | null
  email: string
}

const esc = (s: unknown) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** Groups the launched items by project, preserving first-seen project order. */
function groupByProject(items: LaunchItem[]) {
  const order: string[] = []
  const byProject = new Map<string, { name: string; items: LaunchItem[] }>()
  for (const it of items) {
    if (!byProject.has(it.projectId)) {
      byProject.set(it.projectId, { name: it.projectName, items: [] })
      order.push(it.projectId)
    }
    byProject.get(it.projectId)!.items.push(it)
  }
  return order.map((id) => byProject.get(id)!)
}

function digestHtml(items: LaunchItem[], recipientName: string) {
  const groups = groupByProject(items)
  const body = groups
    .map(
      (g) => `
        <p style="margin:26px 0 10px 0;font-family:${MONO};font-size:11px;font-weight:700;letter-spacing:.09em;text-transform:uppercase;color:${RED};">
          // ${esc(g.name)}
        </p>
        ${g.items
          .map(
            (it) => `
          <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 10px 0;background-color:#ffffff;border:1px solid #ebeced;border-left:3px solid ${RED};border-radius:6px;">
            <tr>
              <td style="padding:14px 16px;">
                <p style="margin:0 0 ${it.blurb ? '6px' : '0'} 0;font-size:15px;font-weight:650;color:${INK};">
                  ${esc(it.title)}
                </p>
                ${
                  it.blurb
                    ? `<p style="margin:0;font-size:14px;color:${MUTED};line-height:1.6;">${esc(it.blurb)}</p>`
                    : ''
                }
                ${
                  it.category
                    ? `<p style="margin:10px 0 0 0;"><span style="display:inline-block;padding:3px 8px;border:1px solid #f0c9cc;border-radius:4px;background-color:#fdf4f5;font-family:${MONO};font-size:10.5px;font-weight:600;letter-spacing:.05em;color:${RED};">${esc(
                        it.category,
                      )}</span></p>`
                    : ''
                }
              </td>
            </tr>
          </table>`,
          )
          .join('')}`,
    )
    .join('')

  const count = items.length
  const lead =
    count === 1
      ? 'One update just went live in the Supro System.'
      : `${count} updates just went live in the Supro System.`
  const tag = count === 1 ? '1 CHANGE' : `${count} CHANGES`

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Supro Update</title></head>
<body style="margin:0;padding:0;background-color:#f4f4f5;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f5;padding:32px 0;">
    <tr><td align="center">
      <table width="620" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
        <!-- Masthead. The logo PNG is red on transparent, so it sits on white and
             the brand reads red-and-white as intended. Scaled to 170px wide
             (~74px tall) rather than the full 620px, which was ~275px tall. -->
        <tr><td style="background-color:#ffffff;padding:18px 28px 12px 28px;">
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td style="vertical-align:middle;">
                <img src="${LOGO}" alt="Superior Contracting &amp; Maintenance" width="170" style="display:block;width:170px;max-width:170px;border:0;" />
              </td>
              <td align="right" style="vertical-align:middle;font-family:${MONO};font-size:10px;font-weight:700;letter-spacing:.13em;color:${RED};white-space:nowrap;line-height:1.7;">
                SUPRO&nbsp;SYSTEM<br />
                <span style="font-weight:400;color:#9ca3af;">PRODUCT&nbsp;UPDATE&nbsp;&nbsp;·&nbsp;&nbsp;${tag}</span>
              </td>
            </tr>
          </table>
        </td></tr>
        <tr><td style="height:3px;background-color:${RED};font-size:0;line-height:0;">&nbsp;</td></tr>
        <tr><td style="padding:26px 32px 0 32px;">
          <p style="margin:0 0 8px 0;font-size:16px;color:${INK};line-height:1.6;">Hi ${esc(recipientName)},</p>
          <p style="margin:0 0 7px 0;font-size:15px;font-weight:600;color:${INK};line-height:1.6;">${esc(lead)}</p>
          <p style="margin:0;font-size:13.5px;color:${MUTED};line-height:1.65;">${esc(SUPRO_BLURB)}</p>
        </td></tr>
        <tr><td style="padding:4px 32px 30px 32px;">${body}</td></tr>
        <tr><td style="padding:0 32px;"><hr style="border:none;border-top:1px dashed #e3e4e6;margin:0;" /></td></tr>
        <tr><td style="padding:22px 32px;background-color:#fafafa;">
          <p style="margin:0 0 4px 0;font-size:12.5px;font-weight:600;color:${INK};">Superior Contracting &amp; Maintenance</p>
          <p style="margin:0;font-family:${MONO};font-size:11px;color:${MUTED};line-height:1.6;">Sent because email notifications are on for your Supro account.</p>
          <p style="margin:12px 0 0 0;font-family:${MONO};font-size:10px;color:#9ca3af;">© ${new Date().getFullYear()} Superior Contracting &amp; Maintenance</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`
}

const chunk = <T,>(arr: T[], size: number): T[][] => {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'POST required' }), { status: 405, headers: JSON_HEADERS })
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  // --- auth ------------------------------------------------------------------
  // Two callers, two threat models:
  //
  //   the deploy webhook   machine to machine, no user — shared secret header
  //   the dashboard button a signed-in human — their own Supabase session
  //
  // The button path exists so the UI never has to ship LAUNCH_WEBHOOK_SECRET to
  // the browser. Note that platform verify_jwt is deliberately OFF: it would
  // reject the webhook (which carries no Authorization header) and it would
  // accept the anon key (which is itself a valid JWT), so it is both too strict
  // and too lax here. The checks below do the real work.
  const providedSecret = req.headers.get('x-launch-secret')
  const authHeader = req.headers.get('Authorization') || ''
  const bearer = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.slice(7).trim() : ''
  let actor = 'weweb-deploy'

  if (providedSecret) {
    const secret = Deno.env.get('LAUNCH_WEBHOOK_SECRET')
    if (!secret) {
      return new Response(
        JSON.stringify({ error: 'LAUNCH_WEBHOOK_SECRET is not set on this function; refusing to run.' }),
        { status: 500, headers: JSON_HEADERS },
      )
    }
    if (providedSecret !== secret) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: JSON_HEADERS })
    }
  } else if (bearer) {
    const { data: userData, error: userError } = await supabase.auth.getUser(bearer)
    const authUser = userData?.user
    if (userError || !authUser) {
      return new Response(JSON.stringify({ error: 'Not signed in.' }), { status: 401, headers: JSON_HEADERS })
    }
    // A valid session is not enough — the caller has to be an active internal
    // user, the same bar the audience view applies to recipients.
    const { data: profile } = await supabase
      .from('users')
      .select('name, email, status')
      .eq('user_auth_id', authUser.id)
      .maybeSingle()

    const email = String(profile?.email || '').trim().toLowerCase()
    const internal = email.endsWith('@superior-maintenance.com')
    if (!profile || profile.status !== 'Active' || !internal) {
      return new Response(
        JSON.stringify({ error: 'You are not authorised to send launch notifications.' }),
        { status: 403, headers: JSON_HEADERS },
      )
    }
    actor = email
  } else {
    return new Response(
      JSON.stringify({ error: 'Unauthorized: send either x-launch-secret or a signed-in Authorization bearer token.' }),
      { status: 401, headers: JSON_HEADERS },
    )
  }

  try {
    const body = await req.json().catch(() => ({}))
    // Opt IN to sending. Anything other than an explicit `false` is a dry run.
    const dryRun = body.dry_run !== false
    const testEmail: string | null = body.test_email || null
    const projectId: string | null = body.project_id || null
    // Who gets recorded on the batch. A caller-supplied value cannot be trusted
    // to identify a person, so the resolved actor wins for signed-in callers.
    const triggeredBy: string = actor !== 'weweb-deploy' ? actor : (body.triggered_by || 'weweb-deploy')

    // --- 1. what is waiting to ship ------------------------------------------
    let queuedQuery = supabase
      .from('product_roadmap_launch_notifications')
      .select(
        'id, item:product_roadmap_items!inner(id, title, description, launch_notes, category, status, project_id, project:product_roadmap_projects!inner(id, name))',
      )
      .eq('status', 'pending')
      .eq('product_roadmap_items.status', 'queued')
      .order('queued_at', { ascending: true })

    if (projectId) queuedQuery = queuedQuery.eq('product_roadmap_items.project_id', projectId)

    const { data: queued, error: queuedError } = await queuedQuery
    if (queuedError) throw queuedError

    const items: LaunchItem[] = (queued ?? []).map((row: any) => ({
      notificationId: row.id,
      itemId: row.item.id,
      title: row.item.title,
      // Announcement copy wins; the internal description is the safety net so an
      // item is never announced with an empty body.
      blurb: row.item.launch_notes || row.item.description || null,
      category: row.item.category,
      projectId: row.item.project.id,
      projectName: row.item.project.name,
    }))

    if (!items.length) {
      return new Response(
        JSON.stringify({ ok: true, dry_run: dryRun, items: 0, message: 'Nothing is queued for launch.' }),
        { status: 200, headers: JSON_HEADERS },
      )
    }

    // --- 2. who hears about it ------------------------------------------------
    const { data: audience, error: audienceError } = await supabase
      .from('product_roadmap_launch_recipients')
      .select('user_id, auth_user_id, name, email')
    if (audienceError) throw audienceError
    const recipients: Recipient[] = (audience ?? []) as Recipient[]

    // Names the system, not just "product" — most recipients are field and office
    // staff who would not otherwise connect a product update to Supro.
    const subject =
      items.length === 1
        ? `Supro update: ${items[0].title} is live`
        : `Supro update: ${items.length} new features are live`

    // --- 3. dry run: preview only, no writes, no sends ------------------------
    if (dryRun) {
      return new Response(
        JSON.stringify({
          ok: true,
          dry_run: true,
          message: 'Preview only — nothing was flipped, written, or sent. Pass "dry_run": false to release.',
          subject,
          items: items.length,
          recipients: recipients.length,
          items_preview: items.map((i) => ({ project: i.projectName, title: i.title })),
          sample_recipients: recipients.slice(0, 5).map((r) => r.email),
          html_preview: digestHtml(items, recipients[0]?.name || 'there'),
        }),
        { status: 200, headers: JSON_HEADERS },
      )
    }

    const resendKey = Deno.env.get('RESEND_API_KEY')
    if (!resendKey) throw new Error('RESEND_API_KEY is not set on this function.')
    const resend = new Resend(resendKey)

    // --- 3b. test send: one real email, queue deliberately left untouched ------
    // Nothing is flipped and nothing is recorded, so you can iterate on the copy
    // and re-send as many times as you like off the same queued items.
    if (testEmail) {
      const { data: testData, error: testError } = await resend.emails.send({
        from: FROM,
        reply_to: REPLY_TO,
        to: testEmail,
        subject: `[TEST] ${subject}`,
        html: digestHtml(items, 'there'),
      })
      if (testError) throw testError

      return new Response(
        JSON.stringify({
          ok: true,
          dry_run: false,
          test_mode: true,
          message: 'Test email sent. Nothing was flipped, written or consumed — the queue is untouched, so you can re-run this.',
          to: testEmail,
          resend_id: (testData as any)?.id ?? null,
          subject: `[TEST] ${subject}`,
          items: items.length,
          would_reach_on_release: recipients.length,
        }),
        { status: 200, headers: JSON_HEADERS },
      )
    }

    if (!recipients.length) {
      return new Response(JSON.stringify({ error: 'No eligible recipients found.' }), {
        status: 404,
        headers: JSON_HEADERS,
      })
    }

    // --- 4. open the batch ----------------------------------------------------
    const { data: batch, error: batchError } = await supabase
      .from('product_roadmap_launch_batches')
      .insert({
        status: 'sending',
        dry_run: false,
        triggered_by: triggeredBy,
        subject,
        item_count: items.length,
        recipient_count: recipients.length,
      })
      .select()
      .single()
    if (batchError || !batch) throw batchError ?? new Error('Could not open a launch batch.')

    const notificationIds = items.map((i) => i.notificationId)
    const itemIds = items.map((i) => i.itemId)

    await supabase
      .from('product_roadmap_launch_notifications')
      .update({ status: 'sending', batch_id: batch.id })
      .in('id', notificationIds)

    // --- 5. release the items -------------------------------------------------
    // The deploy has already happened, so these are live whether or not the email
    // succeeds. Flip first; a send failure is recorded on the batch for retry.
    // The existing trg_prm_status_change trigger writes the status history rows.
    const { error: releaseError } = await supabase
      .from('product_roadmap_items')
      .update({ status: 'launched' })
      .in('id', itemIds)
    if (releaseError) throw releaseError

    const releasedAt = new Date().toISOString()

    // --- 6. record intended recipients ---------------------------------------
    const { data: recipientRows } = await supabase
      .from('product_roadmap_launch_batch_recipients')
      .insert(
        recipients.map((r) => ({
          batch_id: batch.id,
          user_id: r.user_id,
          auth_user_id: r.auth_user_id,
          email: r.email,
          status: 'pending',
        })),
      )
      .select('id, email')

    const rowIdByEmail = new Map<string, string>()
    for (const row of recipientRows ?? []) rowIdByEmail.set(row.email, row.id)

    // --- 7. send, 100 at a time ----------------------------------------------
    let sent = 0
    let failed = 0

    for (const group of chunk(recipients, BATCH_SIZE)) {
      const payloads = group.map((r) => ({
        from: FROM,
        reply_to: REPLY_TO,
        to: r.email,
        subject,
        html: digestHtml(items, r.name || 'there'),
      }))

      try {
        const { data, error } = await resend.batch.send(payloads)
        if (error) throw error

        // Resend returns ids positionally, so index maps back to the recipient.
        const ids: any[] = (data as any)?.data ?? (Array.isArray(data) ? data : [])
        await Promise.all(
          group.map(async (r, i) => {
            const rowId = rowIdByEmail.get(r.email)
            if (!rowId) return
            await supabase
              .from('product_roadmap_launch_batch_recipients')
              .update({ status: 'sent', resend_id: ids[i]?.id ?? null, sent_at: new Date().toISOString() })
              .eq('id', rowId)
          }),
        )
        sent += group.length
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        await Promise.all(
          group.map(async (r) => {
            const rowId = rowIdByEmail.get(r.email)
            if (!rowId) return
            await supabase
              .from('product_roadmap_launch_batch_recipients')
              .update({ status: 'failed', error_message: message })
              .eq('id', rowId)
          }),
        )
        failed += group.length
      }
    }

    // --- 8. close out ---------------------------------------------------------
    await supabase
      .from('product_roadmap_launch_notifications')
      .update({ status: failed === recipients.length ? 'failed' : 'sent', released_at: releasedAt })
      .in('id', notificationIds)

    await supabase
      .from('product_roadmap_launch_batches')
      .update({
        status: failed === recipients.length ? 'failed' : 'sent',
        sent_count: sent,
        failed_count: failed,
        finished_at: new Date().toISOString(),
      })
      .eq('id', batch.id)

    return new Response(
      JSON.stringify({
        ok: true,
        dry_run: false,
        test_mode: false,
        batch_id: batch.id,
        items_launched: items.length,
        recipients: recipients.length,
        sent,
        failed,
      }),
      { status: 200, headers: JSON_HEADERS },
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return new Response(JSON.stringify({ error: message }), { status: 500, headers: JSON_HEADERS })
  }
})
