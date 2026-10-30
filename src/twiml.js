/**
 * TwiML generation. Plain string building - no SDK needed on Workers.
 */

export function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function doc(inner) {
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`;
}

export const XML_CONTENT_TYPE = { 'Content-Type': 'text/xml; charset=UTF-8' };

function gatherOpen(jobId, lang, settings) {
  const attrs = [
    'input="speech"',
    `language="${esc(lang.code)}"`,
    `action="/api/respond?job=${esc(jobId)}"`,
    'method="POST"',
    `speechTimeout="${esc(settings.timeout)}"`,
  ];
  if (settings.model) attrs.push(`speechModel="${esc(settings.model)}"`);
  return `<Gather ${attrs.join(' ')}>`;
}

/**
 * The conversation document:
 *   - speak `sayText` while a speech <Gather> is armed, so Twilio starts
 *     listening as soon as the reply ends;
 *   - fall back to a fresh <Gather> via <Redirect> when the caller says nothing.
 *
 * With `hangup` set it instead says goodbye and ends the call (used after
 * three silent rounds).
 */
export function voiceTwiML({ sayText = '', lang, jobId, settings, hangup = false }) {
  if (hangup) {
    return doc(`<Say language="${esc(lang.code)}">${esc(lang.hangup)}</Say><Hangup/>`);
  }
  const safe = String(sayText)
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 600);
  return doc(
    `${gatherOpen(jobId, lang, settings)}` +
      `<Say language="${esc(lang.code)}">${esc(safe)}</Say>` +
      `</Gather>` +
      `<Redirect method="POST">/api/voice?job=${esc(jobId)}</Redirect>`
  );
}
