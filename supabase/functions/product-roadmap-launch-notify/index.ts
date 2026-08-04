/**
 * product-roadmap-launch-notify
 *
 * Deploy webhook for the product roadmap. Call it after a WeWeb deploy:
 *
 *   POST /functions/v1/product-roadmap-launch-notify
 *   x-launch-secret: <LAUNCH_WEBHOOK_SECRET>
 *   { "dry_run": false }
 *
 * It claims every item sitting in `queued`, flips it to `launched`, and sends one
 * digest email per active user via Resend.
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
const LOGO = 'https://iepfgtjizwzbdgxyzaab.supabase.co/storage/v1/object/public/avatars/headers/1_Superior_C_M_logo.png'
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
        <p style="margin:28px 0 10px 0;font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#8b95a5;">
          ${esc(g.name)}
        </p>
        ${g.items
          .map(
            (it) => `
          <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 12px 0;border:1px solid #e5e7eb;border-radius:8px;">
            <tr>
              <td style="padding:16px 18px;">
                <p style="margin:0 0 ${it.blurb ? '6px' : '0'} 0;font-size:15px;font-weight:650;color:#1a2e44;">
                  ${esc(it.title)}
                </p>
                ${
                  it.blurb
                    ? `<p style="margin:0;font-size:14px;color:#4b5563;line-height:1.6;">${esc(it.blurb)}</p>`
                    : ''
                }
                ${
                  it.category
                    ? `<p style="margin:10px 0 0 0;"><span style="display:inline-block;padding:3px 9px;border-radius:999px;background:#eef2ff;color:#4f46e5;font-size:11px;font-weight:600;">${esc(
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
      ? 'One update just went live.'
      : `${count} updates just went live.`

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Product Update</title></head>
<body style="margin:0;padding:0;background-color:#f4f4f7;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f7;padding:40px 0;">
    <tr><td align="center">
      <table width="620" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
        <tr><td style="background-color:#1a2e44;padding:0;">
          <img src="${LOGO}" alt="Superior Contracting &amp; Maintenance" width="620" style="display:block;width:100%;max-width:620px;" />
        </td></tr>
        <tr><td style="padding:40px 48px 0 48px;">
          <p style="margin:0 0 6px 0;font-size:16px;color:#374151;line-height:1.6;">Hi ${esc(recipientName)},</p>
          <p style="margin:0;font-size:15px;color:#6b7280;line-height:1.6;">${esc(lead)}</p>
        </td></tr>
        <tr><td style="padding:8px 48px 40px 48px;">${body}</td></tr>
        <tr><td style="padding:0 48px;"><hr style="border:none;border-top:1px solid #e5e7eb;margin:0;" /></td></tr>
        <tr><td style="padding:32px 48px;background-color:#f9fafb;">
          <p style="margin:0 0 4px 0;font-size:13px;font-weight:600;color:#1a2e44;">Superior Contracting &amp; Maintenance</p>
          <p style="margin:0;font-size:12px;color:#6b7280;">You're receiving this because email notifications are on for your account.</p>
          <p style="margin:16px 0 0 0;font-size:11px;color:#9ca3af;">© ${new Date().getFullYear()} Superior Contracting &amp; Maintenance. All rights reserved.</p>
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

  // --- auth: shared secret, failing closed if it was never configured ---------
  const secret = Deno.env.get('LAUNCH_WEBHOOK_SECRET')
  if (!secret) {
    return new Response(
      JSON.stringify({ error: 'LAUNCH_WEBHOOK_SECRET is not set on this function; refusing to run.' }),
      { status: 500, headers: JSON_HEADERS },
    )
  }
  if (req.headers.get('x-launch-secret') !== secret) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: JSON_HEADERS })
  }

  try {
    const body = await req.json().catch(() => ({}))
    // Opt IN to sending. Anything other than an explicit `false` is a dry run.
    const dryRun = body.dry_run !== false
    const testEmail: string | null = body.test_email || null
    const projectId: string | null = body.project_id || null
    const triggeredBy: string = body.triggered_by || 'weweb-deploy'

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    )

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

    const subject =
      items.length === 1
        ? `Product update: ${items[0].title} is live`
        : `Product update: ${items.length} new features are live`

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
