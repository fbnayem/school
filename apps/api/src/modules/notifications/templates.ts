/**
 * Notification templates, bilingual.
 *
 * Kept as code rather than database rows for now: these three messages are part of the
 * authentication flows and must exist before any tenant has configured anything. The
 * tenant-editable template system is a later phase (docs/09_INTEGRATIONS.md); when it
 * lands, these become the fallbacks.
 *
 * SMS bodies are written to be short on purpose — the Bangla variants are UCS-2 and every
 * 67 characters past the first 70 is another billed part. `smsEncodingOf` reports the real
 * cost either way; these templates just try not to be embarrassing in that report.
 */

import type { NotificationTemplateKey } from './notification.provider';

export interface RenderedNotification {
  subject: string;
  /** Plain-text email body. */
  emailText: string;
  /** Short SMS body. */
  smsText: string;
}

type Locale = 'en' | 'bn';

interface TemplateData {
  recipientName?: string;
  schoolName?: string;
  actionUrl?: string;
  expiresInText?: string;
  studentName?: string;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

const TEMPLATES: Record<
  NotificationTemplateKey,
  Record<Locale, (data: TemplateData) => RenderedNotification>
> = {
  user_invitation: {
    en: (d) => ({
      subject: `You are invited to ${d.schoolName ?? 'Shikkha'}`,
      emailText:
        `Hello ${d.recipientName ?? ''},\n\n` +
        `You have been invited to join ${d.schoolName ?? 'your school'} on Shikkha.\n` +
        `Open this link to set your password and activate your account:\n\n` +
        `${d.actionUrl}\n\n` +
        `The link can be used once and expires ${d.expiresInText ?? 'soon'}.\n` +
        `If you were not expecting this invitation, you can ignore this message.`,
      smsText: `${d.schoolName ?? 'Shikkha'}: activate your account: ${d.actionUrl} (expires ${d.expiresInText ?? 'soon'})`,
    }),
    bn: (d) => ({
      subject: `${d.schoolName ?? 'শিক্ষা'}-তে আপনার আমন্ত্রণ`,
      emailText:
        `প্রিয় ${d.recipientName ?? ''},\n\n` +
        `আপনাকে ${d.schoolName ?? 'আপনার প্রতিষ্ঠানে'} যোগ দিতে আমন্ত্রণ জানানো হয়েছে।\n` +
        `পাসওয়ার্ড সেট করে অ্যাকাউন্ট চালু করতে এই লিংকটি খুলুন:\n\n` +
        `${d.actionUrl}\n\n` +
        `লিংকটি একবারই ব্যবহারযোগ্য এবং ${d.expiresInText ?? 'শীঘ্রই'} মেয়াদোত্তীর্ণ হবে।`,
      smsText: `${d.schoolName ?? 'শিক্ষা'}: অ্যাকাউন্ট চালু করুন: ${d.actionUrl}`,
    }),
  },
  guardian_invitation: {
    en: (d) => ({
      subject: `Parent portal access — ${d.schoolName ?? 'Shikkha'}`,
      emailText:
        `Hello ${d.recipientName ?? ''},\n\n` +
        `${d.schoolName ?? 'Your school'} has invited you to the parent portal` +
        `${d.studentName ? ` for ${d.studentName}` : ''}.\n` +
        `Open this link to set your password and activate access:\n\n` +
        `${d.actionUrl}\n\n` +
        `The link can be used once and expires ${d.expiresInText ?? 'soon'}.`,
      smsText: `${d.schoolName ?? 'Shikkha'} parent portal: ${d.actionUrl} (expires ${d.expiresInText ?? 'soon'})`,
    }),
    bn: (d) => ({
      subject: `অভিভাবক পোর্টাল — ${d.schoolName ?? 'শিক্ষা'}`,
      emailText:
        `প্রিয় ${d.recipientName ?? ''},\n\n` +
        `${d.schoolName ?? 'আপনার প্রতিষ্ঠান'} আপনাকে অভিভাবক পোর্টালে আমন্ত্রণ জানিয়েছে` +
        `${d.studentName ? ` (${d.studentName})` : ''}।\n` +
        `পাসওয়ার্ড সেট করে অ্যাকাউন্ট চালু করতে এই লিংকটি খুলুন:\n\n` +
        `${d.actionUrl}\n\n` +
        `লিংকটি একবারই ব্যবহারযোগ্য।`,
      smsText: `${d.schoolName ?? 'শিক্ষা'} অভিভাবক পোর্টাল: ${d.actionUrl}`,
    }),
  },
  password_reset: {
    en: (d) => ({
      subject: 'Reset your Shikkha password',
      emailText:
        `Hello ${d.recipientName ?? ''},\n\n` +
        `A password reset was requested for your account. Open this link to choose a new password:\n\n` +
        `${d.actionUrl}\n\n` +
        `The link can be used once and expires ${d.expiresInText ?? 'in 30 minutes'}.\n` +
        `If you did not request this, you can ignore this message; your password is unchanged.`,
      smsText: `Shikkha password reset: ${d.actionUrl} (expires ${d.expiresInText ?? 'in 30 minutes'})`,
    }),
    bn: (d) => ({
      subject: 'শিক্ষা পাসওয়ার্ড রিসেট',
      emailText:
        `প্রিয় ${d.recipientName ?? ''},\n\n` +
        `আপনার অ্যাকাউন্টের পাসওয়ার্ড রিসেটের অনুরোধ এসেছে। নতুন পাসওয়ার্ড দিতে এই লিংকটি খুলুন:\n\n` +
        `${d.actionUrl}\n\n` +
        `লিংকটি একবারই ব্যবহারযোগ্য এবং ${d.expiresInText ?? '৩০ মিনিটে'} মেয়াদোত্তীর্ণ হবে।\n` +
        `অনুরোধটি আপনার না হলে বার্তাটি উপেক্ষা করুন।`,
      smsText: `শিক্ষা পাসওয়ার্ড রিসেট: ${d.actionUrl}`,
    }),
  },
};

export function renderNotification(
  template: NotificationTemplateKey,
  locale: string,
  data: Record<string, unknown>,
): RenderedNotification {
  const chosen: Locale = locale === 'bn' ? 'bn' : 'en';
  const render = TEMPLATES[template][chosen];
  return render({
    recipientName: str(data['recipientName']),
    schoolName: str(data['schoolName']) || undefined,
    actionUrl: str(data['actionUrl']),
    expiresInText: str(data['expiresInText']) || undefined,
    studentName: str(data['studentName']) || undefined,
  });
}
