/**
 * Which providers this deployment has, if any.
 *
 * Every one of these returns null rather than throwing when unconfigured. The
 * engine then records "no email provider is configured" against the step
 * instead of the whole run collapsing — one missing SMS key should not stop
 * the email sequences.
 */

import { resendProvider, twilioProvider, type EmailProvider, type SmsProvider } from './providers';

export type OutreachEnv = Record<string, string | undefined>;

/**
 * Why a channel is unavailable, precisely.
 *
 * "Not configured" is true of three different situations and the fix differs
 * for each. Working out which cost several rounds of guessing once, so the
 * system says it now:
 *
 *   absent — the variable is not in this deployment's environment at all. It
 *            was never added, or the name differs, or the running deployment
 *            predates it (Vercel binds variables when a build is created, so
 *            adding one changes nothing until the next deploy).
 *   blank  — the variable exists but its value is empty or whitespace. A row
 *            saved with nothing in it looks identical to a correct one in a
 *            dashboard listing.
 *   ready  — usable.
 */
export type ProviderState = 'ready' | 'absent' | 'blank';

function stateOf(env: OutreachEnv, name: string): ProviderState {
  if (!(name in env) || env[name] === undefined) return 'absent';
  return (env[name] ?? '').trim() === '' ? 'blank' : 'ready';
}

/** Trimmed, because a key pasted with a trailing newline is still the key. */
function value(env: OutreachEnv, name: string): string {
  return (env[name] ?? '').trim();
}

export function emailProviderState(env: OutreachEnv = process.env): ProviderState {
  return stateOf(env, 'RESEND_API_KEY');
}

export function smsProviderState(env: OutreachEnv = process.env): ProviderState {
  const sid = stateOf(env, 'TWILIO_ACCOUNT_SID');
  const token = stateOf(env, 'TWILIO_AUTH_TOKEN');
  if (sid === 'ready' && token === 'ready') return 'ready';
  // Report the more actionable half: a blank value is a subtler mistake than
  // a missing one, so it wins the message.
  if (sid === 'blank' || token === 'blank') return 'blank';
  return 'absent';
}

/** One sentence naming the variable and what is wrong with it. */
export function providerProblem(state: ProviderState, names: string): string | null {
  if (state === 'ready') return null;
  return state === 'blank'
    ? `${names} is set on this deployment but its value is empty.`
    : `${names} is not set on this deployment. If you have just added it, redeploy — Vercel binds variables when a build is created.`;
}

export function emailProvider(env: OutreachEnv = process.env): EmailProvider | null {
  const key = value(env, 'RESEND_API_KEY');
  return key ? resendProvider(key) : null;
}

export function smsProvider(env: OutreachEnv = process.env): SmsProvider | null {
  const sid = value(env, 'TWILIO_ACCOUNT_SID');
  const token = value(env, 'TWILIO_AUTH_TOKEN');
  return sid && token ? twilioProvider(sid, token) : null;
}

export function isEmailConfigured(env: OutreachEnv = process.env): boolean {
  return emailProviderState(env) === 'ready';
}

export function isSmsConfigured(env: OutreachEnv = process.env): boolean {
  return smsProviderState(env) === 'ready';
}

/**
 * The public base URL, for unsubscribe links.
 *
 * An explicit value wins over the request origin, because a link that has to
 * survive in somebody's inbox for months should not depend on which preview
 * deployment happened to send it.
 */
export function siteUrl(origin?: string, env: OutreachEnv = process.env): string {
  return env.NEXT_PUBLIC_SITE_URL ?? env.OUTREACH_SITE_URL ?? origin ?? 'http://localhost:3000';
}
