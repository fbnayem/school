import { redirect } from 'next/navigation';

/** The root has no content of its own; the shell decides between the app and the login page. */
export default function RootPage() {
  redirect('/dashboard');
}
